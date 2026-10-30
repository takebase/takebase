import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { EnvironmentConfig, ProjectConfig } from "../project-config.ts";
import { readSecretsFile } from "../secrets-file.ts";
import { outputTail } from "../worker-target.ts";
import { migrationFiles, worker } from "./backup-export.ts";
import { type BackupManifest, type BackupPart, sha256 } from "./backup-manifest.ts";
import { type BackupStore, tableCounts, verifyBackup } from "./backups.ts";
import { assertOwned, cloudflareEnv, parseToolJson } from "./environment.ts";
import { environmentEscrow } from "./key-escrow.ts";
import { keyRing } from "./key-lifecycle.ts";
import { storedKeyName } from "./key-names.ts";
import type { EnvelopeStore } from "./key-rotation.ts";
import { verifySecrets } from "./key-rotation.ts";
import type { RemoteDeps } from "./remote-workers.ts";

// `takebase backup restore` (SEGU-226). A restore never writes to the source:
// it recovers one target (a tenant, or the global database) of a backup into a
// new, isolated D1 database and KV namespace, so the recovered data can be
// proven before anyone decides to use it.
//
// Before anything is created, the plan must hold: the backup verifies; it
// belongs to this environment; the target's configuration still matches; its
// migration history is a prefix of the repository's, file for file; every data
// key version its secrets need is in the keys file and opens them; and the
// isolated target does not exist yet. `--dry-run` runs exactly these checks.

export type RestoreTarget = { kind: "global" } | { kind: "tenant"; tenantId: string };

export type RestorePlan = {
	backupId: string;
	environment: string;
	target: RestoreTarget;
	// Stable for a backup and target, so a rerun finds its own progress.
	restoreId: string;
	// The isolated D1 database (remote) or Wrangler state directory (local) it creates.
	database: string;
	namespace: string | null;
	schemaVersion: string | null;
	tables: { name: string; rows: number }[];
	secrets: number;
	keyVersions: number[];
	problems: string[];
};

const decoder = new TextDecoder("utf-8", { fatal: true });

export const targetLabel = (target: RestoreTarget) =>
	target.kind === "global" ? "global" : `tenant:${target.tenantId}`;

// e.g. 20261029t041440z-all-tenant-a; a tenant backup already names its tenant.
export const restoreIdOf = (backupId: string, target: RestoreTarget) => {
	const id = backupId.toLowerCase();
	return id.endsWith("-global") || id.includes("-tenant-")
		? id
		: `${id}-${target.kind === "global" ? "global" : target.tenantId}`;
};

// How a target is shown: remote names as they are, local directories from the repository root.
export const shownTarget = (project: ProjectConfig, environment: EnvironmentConfig, name: string) =>
	environment.remote ? name : relative(project.root, name);

// Remote: `<namePrefix>restore-<restore id>` for both the D1 database and the KV
// namespace. Local: a state directory beside the Worker's own state.
export const restoreNames = (
	project: ProjectConfig,
	environment: EnvironmentConfig,
	plan: Pick<RestorePlan, "restoreId" | "target">,
) => {
	if (environment.remote) {
		const name = `${environment.namePrefix ?? ""}restore-${plan.restoreId}`;
		return { database: name, namespace: plan.target.kind === "tenant" ? name : null };
	}
	const dir = join(
		plan.target.kind === "global" ? project.workers.global : project.workers.tenant,
		".wrangler",
		`restore-${plan.restoreId}`,
	);
	return { database: dir, namespace: plan.target.kind === "tenant" ? dir : null };
};

type ConfigPart = {
	environment?: { name?: unknown; tenants?: { id?: unknown; env?: unknown }[] };
	workers?: {
		global?: { vars?: Record<string, unknown> };
		tenants?: Record<string, { vars?: Record<string, unknown> } | undefined>;
	};
};

export const readPart = async (store: BackupStore, part: BackupPart) => {
	const bytes = await store.get(part.object.key);
	// Verified a moment ago; a change since then is refused, not trusted.
	if (bytes === null || sha256(bytes) !== part.object.sha256)
		throw new Error(`${part.object.key} changed during the restore`);
	return decoder.decode(bytes);
};

// The backup's configuration against today's: the same environment, tenant
// and Worker identity, so data never lands under another tenant or environment.
const configProblems = (
	project: ProjectConfig,
	environment: EnvironmentConfig,
	target: RestoreTarget,
	config: ConfigPart,
) => {
	const problems: string[] = [];
	if (config.environment?.name !== environment.name) {
		problems.push(`the backup's configuration is for environment "${String(config.environment?.name)}"`);
	}
	if (target.kind === "global") {
		const current = worker(project.workers.global, environment.globalEnv, "the global Worker");
		if (config.workers?.global?.vars?.TAKEBASE_ENV !== current.vars.TAKEBASE_ENV) {
			problems.push("the global Worker's TAKEBASE_ENV differs from the backup's");
		}
		return problems;
	}
	const tenant = environment.tenants.find(({ id }) => id === target.tenantId);
	if (tenant === undefined) return [...problems, `tenant ${target.tenantId} is not declared in ${environment.name}`];
	const backedUp = config.environment?.tenants?.find(({ id }) => id === tenant.id);
	if (backedUp === undefined) problems.push(`the backup's configuration does not declare tenant ${tenant.id}`);
	else if (backedUp.env !== tenant.env)
		problems.push(`tenant ${tenant.id} used Wrangler environment "${String(backedUp.env)}", now "${tenant.env}"`);
	const vars = config.workers?.tenants?.[tenant.id]?.vars ?? {};
	const current = worker(project.workers.tenant, tenant.env, `tenant ${tenant.id}`).vars;
	if (vars.TENANT_ID !== tenant.id || current.TENANT_ID !== tenant.id) {
		problems.push(`TENANT_ID of tenant ${tenant.id} differs between the backup and wrangler.jsonc`);
	}
	if (vars.TAKEBASE_ENV !== current.TAKEBASE_ENV)
		problems.push(`TAKEBASE_ENV of tenant ${tenant.id} differs from the backup's`);
	return problems;
};

// The backup's migrations must be the repository's first ones, byte for byte:
// a migration the repository no longer has, or has edited, could not be
// applied on top of the restored database.
const schemaProblems = (part: Extract<BackupPart, { kind: "d1" }>, repository: { name: string; sha256: string }[]) => {
	const problems: string[] = [];
	part.migrations.forEach((migration, i) => {
		const file = repository[i];
		if (file === undefined || file.name !== migration.name) {
			problems.push(`migration ${migration.name} is not the repository's migration ${i + 1}`);
		} else if (migration.sha256 !== file.sha256) {
			problems.push(`migration ${migration.name} differs from the repository's file`);
		}
	});
	return problems.slice(0, 3);
};

// The backup's ciphertext as an envelope store, for key checks in memory.
const backupEnvelopes = (text: string): EnvelopeStore => {
	const entries = new Map<string, string>();
	for (const line of text.split("\n")) {
		if (line === "") continue;
		const { name, value } = JSON.parse(line) as { name: string; value: string };
		entries.set(name, value);
	}
	return {
		names: async () => [...entries.keys()],
		get: async (name) => entries.get(name) ?? null,
		put: async () => {
			throw new Error("the backup's secrets are read-only");
		},
	};
};

// Every key version the secrets use must be in the keys file and open every
// secret stored under it. A key only the escrow holds is reported: recovering
// it is `takebase secrets recover`, never a side effect of a restore.
const keyProblems = async (
	project: ProjectConfig,
	environment: EnvironmentConfig,
	tenantId: string,
	part: Extract<BackupPart, { kind: "kv" }>,
	text: string,
) => {
	const problems: string[] = [];
	const keysFile = environment.keysFile;
	const stored = keysFile === undefined || !existsSync(keysFile) ? {} : readSecretsFile(keysFile).values;
	const escrow = environmentEscrow(environment);
	const tenant = environment.tenants.find(({ id }) => id === tenantId);
	const vars = tenant === undefined ? {} : worker(project.workers.tenant, tenant.env, `tenant ${tenantId}`).vars;
	const scope = { tenantId, environment: vars.TAKEBASE_ENV ?? "" };
	const store = backupEnvelopes(text);
	for (const version of part.keyVersions) {
		if (keysFile === undefined || stored[storedKeyName(tenantId, version)] === undefined) {
			const escrowed = escrow !== null && (await escrow.has({ tenantId, version }));
			problems.push(
				escrowed
					? `data key v${version} of ${tenantId} is only in the escrow: run \`takebase secrets recover ${tenantId}\` first`
					: `data key v${version} of ${tenantId} is in neither the keys file nor the escrow`,
			);
			continue;
		}
		const result = await verifySecrets({ store, keys: keyRing(keysFile, tenantId), scope, target: version });
		if (result.rejected > 0)
			problems.push(`data key v${version} does not open ${result.rejected} of the secrets stored under it`);
	}
	return problems;
};

// Whether the isolated target already exists. Reads only: `d1 list` and
// `kv namespace list` remotely, the state directory locally.
export const existingTarget = (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	names: { database: string; namespace: string | null },
) => {
	if (!environment.remote) return existsSync(names.database) ? [`${names.database} already exists`] : [];
	const list = (args: string[]) => {
		const result = deps.run(project.workers.global, "wrangler", args, cloudflareEnv(environment));
		if (result.status !== 0)
			throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed:\n${outputTail(result.output)}`);
		const value = parseToolJson(result.stdout);
		return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
	};
	const problems: string[] = [];
	if (list(["d1", "list", "--json"]).some((db) => db.name === names.database)) {
		problems.push(`D1 database ${names.database} already exists`);
	}
	if (names.namespace !== null && list(["kv", "namespace", "list"]).some((ns) => ns.title === names.namespace)) {
		problems.push(`KV namespace ${names.namespace} already exists`);
	}
	return problems;
};

export const partOf = <K extends BackupPart["kind"]>(manifest: BackupManifest, kind: K, target: string) =>
	manifest.parts.find((part): part is Extract<BackupPart, { kind: K }> => part.kind === kind && part.target === target);

// The restore plan; `problems` is empty only when a restore may start.
export const planRestore = async (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	store: BackupStore,
	backupId: string,
	target: RestoreTarget,
	// A restore with a progress record already created its own target.
	options: { resuming?: boolean } = {},
): Promise<RestorePlan> => {
	const restoreId = restoreIdOf(backupId, target);
	const names = restoreNames(project, environment, { restoreId, target });
	const plan: RestorePlan = {
		backupId,
		environment: environment.name,
		target,
		restoreId,
		...names,
		schemaVersion: null,
		tables: [],
		secrets: 0,
		keyVersions: [],
		problems: [],
	};
	const fail = (...problems: string[]) => {
		plan.problems.push(...problems);
		return plan;
	};
	const verification = await verifyBackup(store, backupId);
	if (verification.status !== "verified" || verification.manifest === null) {
		return fail(...verification.problems.map((problem) => `backup: ${problem}`));
	}
	const manifest = verification.manifest;
	if (manifest.environment !== environment.name) {
		return fail(`backup ${backupId} belongs to environment "${manifest.environment}", not "${environment.name}"`);
	}
	const label = targetLabel(target);
	const d1 = partOf(manifest, "d1", label);
	const kv = target.kind === "tenant" ? partOf(manifest, "kv", label) : undefined;
	const config = partOf(manifest, "config", "environment");
	if (d1 === undefined) return fail(`backup ${backupId} holds no D1 export for ${label}`);
	if (target.kind === "tenant" && kv === undefined) return fail(`backup ${backupId} holds no secrets for ${label}`);
	if (config === undefined) return fail(`backup ${backupId} holds no configuration`);
	if (target.kind === "tenant" && !environment.tenants.some(({ id }) => id === target.tenantId)) {
		return fail(`tenant ${target.tenantId} is not declared in ${environment.name}`);
	}
	assertOwned(environment, "D1 database", names.database);
	if (names.namespace !== null) assertOwned(environment, "KV namespace", names.namespace);

	plan.problems.push(
		...configProblems(project, environment, target, JSON.parse(await readPart(store, config)) as ConfigPart),
	);
	const tenant = target.kind === "tenant" ? environment.tenants.find(({ id }) => id === target.tenantId) : undefined;
	const workerConfig =
		tenant === undefined
			? worker(project.workers.global, environment.globalEnv, "the global Worker")
			: worker(project.workers.tenant, tenant.env, `tenant ${tenant.id}`);
	const repository = migrationFiles(
		target.kind === "global" ? project.workers.global : project.workers.tenant,
		workerConfig,
	);
	plan.problems.push(...schemaProblems(d1, repository));
	plan.schemaVersion = d1.schemaVersion;
	plan.tables = tableCounts(await readPart(store, d1));
	if (target.kind === "tenant" && kv !== undefined) {
		plan.secrets = kv.count;
		plan.keyVersions = kv.keyVersions;
		plan.problems.push(...(await keyProblems(project, environment, target.tenantId, kv, await readPart(store, kv))));
	}
	if (options.resuming !== true) plan.problems.push(...existingTarget(deps, project, environment, names));
	return plan;
};
