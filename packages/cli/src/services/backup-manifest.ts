import { createHash } from "node:crypto";
import { CliError } from "../errors.ts";

// The backup manifest (SEGU-225): what one backup holds and how to prove it is
// intact. A backup is a set of objects under `backups/<backupId>/` plus this
// manifest, written last. Each part was captured at its own time: a backup is
// never one atomic snapshot across D1 databases, KV and configuration.
//
// Integrity, not authenticity: the checksums detect corrupted, truncated,
// missing or edited objects, not someone with write access to the bucket who
// rewrites the objects, the manifest and the catalog consistently.

export type BackupScope = "tenant" | "global" | "all";

export type BackupObject = { key: string; bytes: number; sha256: string };

// A migration applied to the database, with the checksum of the repository file of that name.
export type BackupMigration = { name: string; sha256: string | null };

export type BackupPart =
	| {
			kind: "d1";
			// "global" or "tenant:<id>".
			target: string;
			database: string;
			capturedAt: string;
			// The last applied migration, or null for an empty history.
			schemaVersion: string | null;
			migrations: BackupMigration[];
			object: BackupObject;
	  }
	| {
			kind: "kv";
			target: string;
			binding: string;
			capturedAt: string;
			// Ciphertext envelopes only; the data key versions they need, never a key.
			count: number;
			keyVersions: number[];
			object: BackupObject;
	  }
	| { kind: "config"; target: string; capturedAt: string; object: BackupObject };

export type BackupManifest = {
	format: "takebase-backup";
	version: 1;
	backupId: string;
	created: string;
	environment: string;
	scope: BackupScope;
	cliVersion: string;
	parts: BackupPart[];
	// SHA-256 of the canonical JSON of every other field.
	manifestSha256: string;
};

export type BackupCatalogEntry = { backupId: string; created: string; scope: BackupScope; manifestSha256: string };

// A backup being pruned (SEGU-226): already out of `backups`, its objects
// still to delete. A rerun of prune finishes it.
export type BackupPruning = { backupId: string; keys: string[] };

// `backups/catalog.json`: Wrangler cannot list R2 objects, so the catalog is
// how backups are found. It never holds a verification result.
export type BackupCatalog = { version: 1; backups: BackupCatalogEntry[]; pruning?: BackupPruning[] };

export const catalogKey = "backups/catalog.json";
export const backupPrefix = (backupId: string) => `backups/${backupId}/`;
export const manifestKey = (backupId: string) => `${backupPrefix(backupId)}manifest.json`;

const backupIdPattern = /^\d{8}T\d{6}Z-(tenant-[a-z0-9][a-z0-9-]*|global|all)$/;
export const isBackupId = (value: string) => backupIdPattern.test(value);

// `<UTC yyyymmddThhmmssZ>-<global|all|tenant-<id>>`, e.g. 20261028T120000Z-all.
export const backupIdOf = (created: Date, scope: BackupScope, tenantId?: string) =>
	`${created
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "")}-${scope === "tenant" ? `tenant-${tenantId}` : scope}`;

export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// JSON with object keys sorted at every level, so one value has one encoding.
export const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
};

export const manifestChecksum = (manifest: Omit<BackupManifest, "manifestSha256">) => {
	const { manifestSha256: _ignored, ...rest } = manifest as BackupManifest;
	return sha256(canonicalJson(rest));
};

export const sealManifest = (draft: Omit<BackupManifest, "manifestSha256">): BackupManifest => ({
	...draft,
	manifestSha256: manifestChecksum(draft),
});

export const describeObject = (key: string, bytes: Uint8Array): BackupObject => ({
	key,
	bytes: bytes.byteLength,
	sha256: sha256(bytes),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const isObjectEntry = (value: unknown): value is BackupObject =>
	isRecord(value) &&
	typeof value.key === "string" &&
	typeof value.bytes === "number" &&
	typeof value.sha256 === "string";

const isPart = (value: unknown): value is BackupPart => {
	if (!isRecord(value) || typeof value.target !== "string" || typeof value.capturedAt !== "string") return false;
	if (!isObjectEntry(value.object)) return false;
	if (value.kind === "d1") {
		return (
			typeof value.database === "string" &&
			(value.schemaVersion === null || typeof value.schemaVersion === "string") &&
			Array.isArray(value.migrations) &&
			value.migrations.every((migration) => isRecord(migration) && typeof migration.name === "string")
		);
	}
	if (value.kind === "kv") {
		return (
			typeof value.binding === "string" &&
			typeof value.count === "number" &&
			Array.isArray(value.keyVersions) &&
			value.keyVersions.every((version) => typeof version === "number")
		);
	}
	return value.kind === "config";
};

// The manifest, if the bytes hold one of the expected shape; otherwise null.
export const parseManifest = (text: string): BackupManifest | null => {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(value) || value.format !== "takebase-backup" || value.version !== 1) return null;
	const fields = ["backupId", "created", "environment", "scope", "cliVersion", "manifestSha256"];
	if (!fields.every((field) => typeof value[field] === "string")) return null;
	if (!Array.isArray(value.parts) || !value.parts.every(isPart)) return null;
	return value as BackupManifest;
};

const isCatalogEntry = (value: unknown): value is BackupCatalogEntry =>
	isRecord(value) &&
	["backupId", "created", "scope", "manifestSha256"].every((field) => typeof value[field] === "string");

const isPruning = (value: unknown): value is BackupPruning =>
	isRecord(value) &&
	typeof value.backupId === "string" &&
	Array.isArray(value.keys) &&
	value.keys.every((key) => typeof key === "string");

export const parseCatalog = (text: string | null): BackupCatalog => {
	if (text === null) return { version: 1, backups: [] };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		value = undefined;
	}
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!Array.isArray(value.backups) ||
		!value.backups.every(isCatalogEntry) ||
		(value.pruning !== undefined && (!Array.isArray(value.pruning) || !value.pruning.every(isPruning)))
	) {
		throw new CliError(`${catalogKey} is not a backup catalog`, {
			hint: "Nothing was changed. Inspect the object in the bucket before writing another backup.",
		});
	}
	return value as BackupCatalog;
};
