import type {
	BackupCatalog,
	BackupCatalogEntry,
	BackupManifest,
	BackupPart,
	TenantBackup,
	TenantBackupCheck,
	TenantRestorePlan,
} from "@takebase/contracts";
import { parseEnvelope } from "../secrets/envelope.ts";

// A tenant's backups as its admins see them (SEGU-227), read from the
// environment's backup bucket by the global Worker. Read-only by type: the
// bucket passed in offers `get` alone, so nothing here can write or delete.
// Answers carry manifest metadata about this tenant only, never object bytes,
// other tenants' parts or the global database. The CLI wrote the backups
// (`takebase backup create`) and remains the only way to restore or prune.

// The part of an R2 bucket binding this module uses.
export type BackupBucket = {
	get: (key: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; size: number } | null>;
};

export const catalogKey = "backups/catalog.json";
const backupPrefix = (backupId: string) => `backups/${backupId}/`;
const manifestKey = (backupId: string) => `${backupPrefix(backupId)}manifest.json`;
const backupIdPattern = /^\d{8}T\d{6}Z-(tenant-[a-z0-9][a-z0-9-]*|global|all)$/;
export const isBackupId = (value: string) => backupIdPattern.test(value);

// The newest catalogued backups considered for a list.
export const maxListed = 50;
// Larger objects are not hashed in the Worker; `takebase backup verify` checks them.
export const maxCheckedBytes = 64 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const hex = (buffer: ArrayBuffer) =>
	[...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (data: ArrayBuffer | string) =>
	hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data));

// JSON with object keys sorted at every level, as the CLI seals manifests.
const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";

const isPart = (value: unknown): value is BackupPart => {
	if (!isRecord(value) || !isText(value.target) || !isText(value.capturedAt) || !isRecord(value.object)) return false;
	const { object } = value;
	if (!isText(object.key) || typeof object.bytes !== "number" || !isText(object.sha256)) return false;
	if (value.kind === "d1") {
		return (
			(value.schemaVersion === null || isText(value.schemaVersion)) &&
			Array.isArray(value.migrations) &&
			value.migrations.every((migration) => isRecord(migration) && isText(migration.name))
		);
	}
	if (value.kind === "kv") {
		return (
			typeof value.count === "number" &&
			Array.isArray(value.keyVersions) &&
			value.keyVersions.every((version) => typeof version === "number")
		);
	}
	return value.kind === "config";
};

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

const parseManifest = (text: string): BackupManifest | null => {
	const value = parseJson(text);
	if (!isRecord(value) || value.format !== "takebase-backup" || value.version !== 1) return null;
	const fields = ["backupId", "created", "environment", "scope", "cliVersion", "manifestSha256"];
	if (!fields.every((field) => isText(value[field]))) return null;
	if (!Array.isArray(value.parts) || !value.parts.every(isPart)) return null;
	return value as BackupManifest;
};

const isEntry = (value: unknown): value is BackupCatalogEntry =>
	isRecord(value) && ["backupId", "created", "scope", "manifestSha256"].every((field) => isText(value[field]));

const readText = async (bucket: BackupBucket, key: string) => {
	const object = await bucket.get(key);
	if (object === null) return null;
	try {
		return decoder.decode(await object.arrayBuffer());
	} catch {
		return undefined;
	}
};

// The catalog's entries, newest first; empty when there is no catalog yet.
const catalogEntries = async (bucket: BackupBucket) => {
	const text = await readText(bucket, catalogKey);
	if (text === null) return [];
	const catalog = text === undefined ? undefined : (parseJson(text) as BackupCatalog | undefined);
	if (!isRecord(catalog) || catalog.version !== 1 || !Array.isArray(catalog.backups)) {
		throw new Error(`${catalogKey} is not a backup catalog`);
	}
	return catalog.backups.filter(isEntry).sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
};

const target = (tenantId: string) => `tenant:${tenantId}`;
const tenantParts = (manifest: BackupManifest, tenantId: string) =>
	manifest.parts.filter((part) => part.target === target(tenantId) && part.kind !== "config");

// What the admin sees of one backup: this tenant's parts only.
const describe = (manifest: BackupManifest, tenantId: string): TenantBackup => {
	const parts = tenantParts(manifest, tenantId);
	const d1 = parts.find((part) => part.kind === "d1");
	const kv = parts.find((part) => part.kind === "kv");
	return {
		backupId: manifest.backupId,
		created: manifest.created,
		scope: manifest.scope,
		environment: manifest.environment,
		parts: parts.map((part) => ({
			kind: part.kind as "d1" | "kv",
			capturedAt: part.capturedAt,
			bytes: part.object.bytes,
		})),
		schemaVersion: d1?.kind === "d1" ? d1.schemaVersion : null,
		migrations: d1?.kind === "d1" ? d1.migrations.map(({ name }) => name) : [],
		keyVersions: kv?.kind === "kv" ? [...kv.keyVersions] : [],
	};
};

const readManifest = async (bucket: BackupBucket, backupId: string) => {
	const text = await readText(bucket, manifestKey(backupId));
	return typeof text === "string" ? parseManifest(text) : null;
};

// Backups that hold this tenant, newest first. A backup whose manifest is
// missing or unreadable is listed by nobody: `takebase backup list` reports it.
export const listTenantBackups = async (bucket: BackupBucket, tenantId: string): Promise<TenantBackup[]> => {
	const listed: TenantBackup[] = [];
	for (const entry of (await catalogEntries(bucket)).slice(0, maxListed)) {
		if (!isBackupId(entry.backupId)) continue;
		const manifest = await readManifest(bucket, entry.backupId);
		if (manifest === null || manifest.backupId !== entry.backupId) continue;
		if (tenantParts(manifest, tenantId).some((part) => part.kind === "d1")) listed.push(describe(manifest, tenantId));
	}
	return listed;
};

// The key versions in a secrets export, after checking every line is an envelope.
const readKv = (text: string) => {
	const lines = text.split("\n").filter((line) => line !== "");
	const versions = new Set<number>();
	for (const line of lines) {
		const entry = parseJson(line);
		if (!isRecord(entry) || !isText(entry.name) || !entry.name.startsWith("secret/") || !isText(entry.value)) {
			throw new Error("an entry is not a secret/ key with a string value");
		}
		versions.add(parseEnvelope(entry.value).keyVersion);
	}
	return { count: lines.length, keyVersions: [...versions].sort((a, b) => a - b) };
};

const sameList = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((item, i) => item === b[i]);

// Null when the backup is not one this tenant may see (unknown, malformed, or
// without this tenant's database): the caller answers 404 for all of them.
export const checkTenantBackup = async (
	bucket: BackupBucket,
	backupId: string,
	tenantId: string,
): Promise<TenantBackupCheck | null> => {
	if (!isBackupId(backupId)) return null;
	const entry = (await catalogEntries(bucket)).find((candidate) => candidate.backupId === backupId);
	const manifest = await readManifest(bucket, backupId);
	if (manifest === null || manifest.backupId !== backupId) return null;
	const parts = tenantParts(manifest, tenantId);
	if (!parts.some((part) => part.kind === "d1")) return null;

	const problems: string[] = [];
	const checked: string[] = [];
	if (entry === undefined) problems.push("not in the catalog (incomplete or foreign backup)");
	else if (entry.manifestSha256 !== manifest.manifestSha256) problems.push("manifest differs from the catalog entry");
	const { manifestSha256, ...sealed } = manifest;
	if ((await sha256(canonicalJson(sealed))) !== manifestSha256) problems.push("manifest checksum mismatch");
	checked.push("manifest checksum and catalog entry");

	for (const part of [...parts, ...manifest.parts.filter(({ kind }) => kind === "config")]) {
		const { key, bytes, sha256: expected } = part.object;
		const name = `${part.kind} export`;
		if (!key.startsWith(backupPrefix(backupId))) {
			problems.push(`${name}: outside the backup`);
			continue;
		}
		if (bytes > maxCheckedBytes) {
			problems.push(`${name}: too large to check here; run takebase backup verify`);
			continue;
		}
		const object = await bucket.get(key);
		if (object === null) {
			problems.push(`${name}: missing`);
			continue;
		}
		const content = await object.arrayBuffer();
		if (content.byteLength !== bytes) {
			problems.push(`${name}: ${content.byteLength} bytes, expected ${bytes} (truncated or altered)`);
			continue;
		}
		if ((await sha256(content)) !== expected) {
			problems.push(`${name}: checksum mismatch`);
			continue;
		}
		checked.push(`${name}: size and SHA-256`);
		if (part.kind === "kv") {
			try {
				const { count, keyVersions } = readKv(decoder.decode(content));
				if (count !== part.count) problems.push(`${name}: holds ${count} secrets, the manifest says ${part.count}`);
				else if (!sameList(keyVersions, part.keyVersions))
					problems.push(`${name}: key versions differ from the manifest`);
				else checked.push(`${name}: ${count} ciphertext envelopes, key versions ${keyVersions.join(", ") || "none"}`);
			} catch {
				problems.push(`${name}: unreadable`);
			}
		}
	}
	return { backupId, status: problems.length === 0 ? "verified" : "failed", problems, checked };
};

// e.g. 20261029t041440z-all-tenant-a, as the CLI names it; a tenant backup already names its tenant.
const restoreIdOf = (backupId: string, tenantId: string) => {
	const id = backupId.toLowerCase();
	return id.includes("-tenant-") ? id : `${id}-${tenantId}`;
};

// What a restore needs from the backup's own configuration part, for this tenant only.
const readConfig = async (bucket: BackupBucket, manifest: BackupManifest, tenantId: string) => {
	const part = manifest.parts.find(({ kind }) => kind === "config");
	const text = part === undefined ? null : await readText(bucket, part.object.key);
	const config = typeof text === "string" ? parseJson(text) : undefined;
	if (!isRecord(config) || !isRecord(config.environment)) return null;
	const { name, remote, namePrefix, tenants } = config.environment;
	const declared = Array.isArray(tenants) && tenants.some((tenant) => isRecord(tenant) && tenant.id === tenantId);
	const workers = isRecord(config.workers) && isRecord(config.workers.tenants) ? config.workers.tenants : {};
	const worker = workers[tenantId];
	const vars = isRecord(worker) && isRecord(worker.vars) ? worker.vars : {};
	return { name, remote: remote === true, namePrefix: isText(namePrefix) ? namePrefix : "", declared, vars };
};

// The plan as far as the backup itself can tell. The SDK adds what only this
// tenant's Worker knows: its applied migrations and installed keys. Null like
// checkTenantBackup.
export const planTenantRestore = async (
	bucket: BackupBucket,
	backupId: string,
	tenantId: string,
): Promise<TenantRestorePlan | null> => {
	const check = await checkTenantBackup(bucket, backupId, tenantId);
	const manifest = check === null ? null : await readManifest(bucket, backupId);
	if (check === null || manifest === null) return null;
	const { migrations, schemaVersion, keyVersions, environment } = describe(manifest, tenantId);
	const kv = tenantParts(manifest, tenantId).find((part) => part.kind === "kv");
	const restoreId = restoreIdOf(backupId, tenantId);

	const problems = [...check.problems];
	const config = await readConfig(bucket, manifest, tenantId);
	if (config === null) problems.push("the backup's configuration is missing or unreadable");
	else {
		if (config.name !== environment)
			problems.push(`the backup's configuration is for environment "${String(config.name)}"`);
		if (!config.declared) problems.push("the backup's configuration does not declare this tenant");
		else if (config.vars.TENANT_ID !== tenantId) problems.push("the backup's TENANT_ID differs from this tenant");
	}
	const name =
		config === null
			? null
			: config.remote
				? `${config.namePrefix}restore-${restoreId}`
				: `.wrangler/restore-${restoreId}`;
	const command = `takebase backup restore ${backupId} --tenant ${tenantId}`;
	return {
		backupId,
		tenantId,
		environment,
		restoreId,
		target: name === null ? null : { database: name, namespace: name },
		schemaVersion,
		migrations,
		secrets: kv?.kind === "kv" ? kv.count : 0,
		keyVersions,
		check,
		problems,
		commands: {
			dryRun: `${command} --dry-run --env ${environment}`,
			restore: `${command} --confirm ${environment} --env ${environment}`,
		},
	};
};
