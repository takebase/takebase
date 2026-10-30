import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../errors.ts";
import type { EnvironmentConfig, ProjectConfig } from "../project-config.ts";
import { outputTail } from "../worker-target.ts";
import { withTemp, worker } from "./backup-export.ts";
import type { BackupManifest } from "./backup-manifest.ts";
import type { BackupStore } from "./backups.ts";
import { contentDigest, importSql } from "./backups.ts";
import { assertOwned, cloudflareEnv, parseToolJson } from "./environment.ts";
import { keyRing, wranglerStore } from "./key-lifecycle.ts";
import { verifySecrets } from "./key-rotation.ts";
import type { RemoteDeps } from "./remote-workers.ts";
import { partOf, type RestorePlan, type RestoreTarget, readPart, shownTarget } from "./restore.ts";

// Running a restore (SEGU-226) whose plan passed: create the isolated target,
// import the D1 export, put the ciphertext secrets, then prove the result.
// Every step is recorded before and after it runs, so a rerun of the same
// command continues where an interrupted one stopped:
//   planned → created → importing-d1 → imported-d1 → imported-kv → proved
// The D1 import is the one step that cannot simply run again: an interrupted
// import is redone only while the target has no tables, otherwise the restore
// stops and `--discard` removes the half-made target.
//
// The progress record holds names, steps, counts and digests: never a key, a
// secret's name or value, or a password.

export type RestoreStep = "planned" | "created" | "importing-d1" | "imported-d1" | "imported-kv" | "proved";

export type RestoreProgress = {
	restoreId: string;
	backupId: string;
	environment: string;
	target: RestoreTarget;
	database: string;
	// Remote only: the IDs Cloudflare gave the new database and namespace.
	databaseId: string | null;
	namespace: string | null;
	namespaceId: string | null;
	step: RestoreStep;
	started: string;
	updated: string;
	proof: { tables: number; rows: number; secrets: number; opened: number } | null;
};

const steps: readonly RestoreStep[] = ["planned", "created", "importing-d1", "imported-d1", "imported-kv", "proved"];
const after = (progress: RestoreProgress, step: RestoreStep) => steps.indexOf(progress.step) >= steps.indexOf(step);

// Untracked, beside the operator files: ops/.restores/<environment>-<restore id>.json.
export const restoresDir = (project: ProjectConfig) => join(project.root, "ops", ".restores");
const progressPath = (project: ProjectConfig, environment: string, restoreId: string) =>
	join(restoresDir(project), `${environment}-${restoreId}.json`);

export const readRestoreProgress = (
	project: ProjectConfig,
	environment: string,
	restoreId: string,
): RestoreProgress | null => {
	const path = progressPath(project, environment, restoreId);
	if (!existsSync(path)) return null;
	let value: Partial<RestoreProgress> | null = null;
	try {
		value = JSON.parse(readFileSync(path, "utf8")) as Partial<RestoreProgress>;
	} catch {}
	if (
		value === null ||
		value.restoreId !== restoreId ||
		value.environment !== environment ||
		!steps.includes(value.step as RestoreStep) ||
		typeof value.database !== "string"
	) {
		throw new CliError(`${path} is not this restore's progress record`, {
			hint: "Inspect or remove it by hand; nothing was changed.",
		});
	}
	return value as RestoreProgress;
};

// Every recorded restore of an environment, newest first.
export const listRestores = (project: ProjectConfig, environment: string) => {
	const dir = restoresDir(project);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.startsWith(`${environment}-`) && file.endsWith(".json"))
		.map((file) => readRestoreProgress(project, environment, file.slice(environment.length + 1, -".json".length)))
		.filter((progress): progress is RestoreProgress => progress !== null)
		.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
};

const save = (project: ProjectConfig, progress: RestoreProgress, step: RestoreStep) => {
	progress.step = step;
	progress.updated = new Date().toISOString();
	mkdirSync(restoresDir(project), { recursive: true, mode: 0o700 });
	writeFileSync(
		progressPath(project, progress.environment, progress.restoreId),
		`${JSON.stringify(progress, null, "\t")}\n`,
		{ mode: 0o600 },
	);
};

const fail = (message: string, output: string) => new CliError(`${message}:\n${outputTail(output)}`);

// Wrangler against the isolated target only. Remotely through a temporary
// configuration that binds nothing but the new database (and namespace), so
// no call can resolve to the source; locally through the target's own
// --persist-to state directory.
const targetWrangler = (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	progress: RestoreProgress,
) => {
	const tenant =
		progress.target.kind === "tenant"
			? environment.tenants.find(({ id }) => progress.target.kind === "tenant" && id === progress.target.tenantId)
			: undefined;
	const dir = tenant === undefined ? project.workers.global : project.workers.tenant;
	const env = tenant === undefined ? environment.globalEnv : tenant.env;
	// `location` gives the target's arguments, with a temporary directory for remote configuration.
	const run = (args: string[], location: (temp: string) => string[]) =>
		withTemp((temp) => deps.run(dir, "wrangler", [...args, ...location(temp)], cloudflareEnv(environment)));
	const remoteConfig = (temp: string) => {
		const config = join(temp, "wrangler.jsonc");
		writeFileSync(
			config,
			JSON.stringify({
				name: "takebase-restore-target",
				compatibility_date: "2026-10-01",
				d1_databases: [{ binding: "DB", database_name: progress.database, database_id: progress.databaseId }],
			}),
		);
		return ["-c", config];
	};
	const d1Location = (temp: string) =>
		environment.remote
			? ["--remote", ...remoteConfig(temp)]
			: ["--local", "--persist-to", progress.database, ...(env === undefined ? [] : ["--env", env])];
	const kvLocation = environment.remote
		? ["--namespace-id", progress.namespaceId ?? "", "--remote"]
		: ["--binding", "SECRETS", "--env", env ?? "", "--local", "--persist-to", progress.namespace ?? ""];
	return { dir, tenant, run, d1Location, kvLocation };
};

const listRemote = (deps: RemoteDeps, project: ProjectConfig, environment: EnvironmentConfig, args: string[]) => {
	const result = deps.run(project.workers.global, "wrangler", args, cloudflareEnv(environment));
	if (result.status !== 0) throw fail(`wrangler ${args.slice(0, 3).join(" ")} failed`, result.output);
	const value = parseToolJson(result.stdout);
	return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
};

// Creates what does not exist yet (a rerun after a crash between the two
// creations finds the first), never without --update-config=false.
const createTarget = (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	progress: RestoreProgress,
) => {
	if (!environment.remote) {
		mkdirSync(progress.database, { recursive: true });
		return;
	}
	const create = (args: string[]) => {
		const result = deps.run(project.workers.global, "wrangler", args, cloudflareEnv(environment));
		if (result.status !== 0) throw fail(`wrangler ${args.slice(0, 3).join(" ")} ${args[3]} failed`, result.output);
	};
	const database = () =>
		listRemote(deps, project, environment, ["d1", "list", "--json"]).find((db) => db.name === progress.database);
	if (database() === undefined) create(["d1", "create", progress.database, "--update-config=false"]);
	progress.databaseId = String(database()?.uuid ?? "");
	if (progress.databaseId === "")
		throw new CliError(`D1 database ${progress.database} was not found after its creation`);
	if (progress.namespace === null) return;
	const namespace = () =>
		listRemote(deps, project, environment, ["kv", "namespace", "list"]).find((ns) => ns.title === progress.namespace);
	if (namespace() === undefined) create(["kv", "namespace", "create", progress.namespace, "--update-config=false"]);
	progress.namespaceId = String(namespace()?.id ?? "");
	if (progress.namespaceId === "")
		throw new CliError(`KV namespace ${progress.namespace} was not found after its creation`);
};

const userTables =
	"SELECT count(*) AS tables FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_' AND substr(name, 1, 4) != '_cf_'";

export type RestoreReport = (line: string) => void;

// Runs (or continues) a restore whose plan holds no problems; returns its progress, proved.
export const executeRestore = async (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	store: BackupStore,
	manifest: BackupManifest,
	plan: RestorePlan,
	report: RestoreReport,
): Promise<RestoreProgress> => {
	if (plan.problems.length > 0) throw new CliError("The restore plan has problems; nothing was created or changed");
	const shown = (name: string | null) => shownTarget(project, environment, name ?? "");
	assertOwned(environment, "D1 database", plan.database);
	if (plan.namespace !== null) assertOwned(environment, "KV namespace", plan.namespace);
	const now = new Date().toISOString();
	const progress: RestoreProgress = readRestoreProgress(project, environment.name, plan.restoreId) ?? {
		restoreId: plan.restoreId,
		backupId: plan.backupId,
		environment: environment.name,
		target: plan.target,
		database: plan.database,
		databaseId: null,
		namespace: plan.namespace,
		namespaceId: null,
		step: "planned",
		started: now,
		updated: now,
		proof: null,
	};
	if (progress.backupId !== plan.backupId) {
		throw new CliError(`Restore ${plan.restoreId} was started from backup ${progress.backupId}`);
	}
	if (progress.step === "planned") save(project, progress, "planned");
	const label = plan.target.kind === "global" ? "global" : `tenant:${plan.target.tenantId}`;
	const d1Part = partOf(manifest, "d1", label);
	const kvPart = plan.target.kind === "tenant" ? partOf(manifest, "kv", label) : undefined;
	if (d1Part === undefined) throw new CliError(`Backup ${plan.backupId} holds no D1 export for ${label}`);

	if (!after(progress, "created")) {
		createTarget(deps, project, environment, progress);
		save(project, progress, "created");
		report(
			`created ${shown(progress.database)}${progress.namespace === null || progress.namespace === progress.database ? "" : ` and ${shown(progress.namespace)}`}`,
		);
	}
	const target = targetWrangler(deps, project, environment, progress);

	if (!after(progress, "imported-d1")) {
		const count = target.run(["d1", "execute", "DB", "--json", "--command", userTables], target.d1Location);
		const start = count.stdout.indexOf("[");
		const tables =
			count.status === 0 && start !== -1
				? Number(
						((JSON.parse(count.stdout.slice(start)) as { results?: { tables?: number }[] }[])[0]?.results ?? [])[0]
							?.tables ?? 0,
					)
				: Number.NaN;
		if (Number.isNaN(tables)) throw fail(`Could not inspect ${progress.database}`, count.output);
		if (tables > 0) {
			throw new CliError(`${shown(progress.database)} already holds tables: an earlier import was interrupted`, {
				hint: `Nothing was written. Remove the half-made target with \`takebase backup restore --discard ${progress.restoreId} --confirm ${environment.name}\` and run the restore again.`,
			});
		}
		save(project, progress, "importing-d1");
		const sql = importSql(await readPart(store, d1Part));
		const imported = withTemp((temp) => {
			const file = join(temp, "restore.sql");
			writeFileSync(file, sql, { mode: 0o600 });
			return target.run(["d1", "execute", "DB", "--file", file, "--yes"], target.d1Location);
		});
		if (imported.status !== 0)
			throw fail(`wrangler d1 execute --file into ${progress.database} failed`, imported.output);
		save(project, progress, "imported-d1");
		report(`imported the D1 export into ${shown(progress.database)}`);
	}

	if (!after(progress, "imported-kv")) {
		if (kvPart !== undefined && kvPart.count > 0) {
			const lines = (await readPart(store, kvPart)).split("\n").filter((line) => line !== "");
			const entries = lines.map((line) => {
				const { name, value, metadata } = JSON.parse(line) as { name: string; value: string; metadata: unknown };
				return { key: name, value, ...(metadata === undefined || metadata === null ? {} : { metadata }) };
			});
			const put = withTemp((temp) => {
				const file = join(temp, "secrets.json");
				writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
				return target.run(["kv", "bulk", "put", file], () => target.kvLocation);
			});
			if (put.status !== 0) throw fail(`wrangler kv bulk put into ${progress.namespace} failed`, put.output);
			report(`put ${entries.length} ciphertext secrets into ${shown(progress.namespace)}`);
		}
		save(project, progress, "imported-kv");
	}

	if (!after(progress, "proved")) {
		progress.proof = await proveRestore(deps, project, environment, store, manifest, progress, target);
		save(project, progress, "proved");
	}
	return progress;
};

// The restored target against the backup, never by row counts alone: the
// restored database exported again holds the same schema and the same rows
// in every table, and the restored namespace holds the same envelopes, each
// of which the tenant's key opens.
const proveRestore = async (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	store: BackupStore,
	manifest: BackupManifest,
	progress: RestoreProgress,
	target: ReturnType<typeof targetWrangler>,
) => {
	const label = progress.target.kind === "global" ? "global" : `tenant:${progress.target.tenantId}`;
	const d1Part = partOf(manifest, "d1", label);
	if (d1Part === undefined) throw new CliError(`Backup ${progress.backupId} holds no D1 export for ${label}`);
	const expected = contentDigest(await readPart(store, d1Part));
	const exported = withTemp((temp) => {
		const output = join(temp, "restored.sql");
		const local = environment.remote ? [] : localExportConfig(project, progress, temp, target);
		const result = target.run(["d1", "export", "DB", "--output", output], (inner) =>
			environment.remote ? target.d1Location(inner) : ["--local", ...local],
		);
		if (result.status !== 0 || !existsSync(output))
			throw fail(`wrangler d1 export of ${progress.database} failed`, result.output);
		return readFileSync(output, "utf8");
	});
	const actual = contentDigest(exported);
	const problems: string[] = [];
	if (actual.schema !== expected.schema) problems.push("the restored schema differs from the backup's");
	for (const [name, table] of Object.entries(expected.tables)) {
		const restored = actual.tables[name];
		if (restored === undefined) problems.push(`table ${name} is missing`);
		else if (restored.sha256 !== table.sha256)
			problems.push(`table ${name}: ${restored.rows} rows differ from the backup's ${table.rows}`);
	}
	for (const name of Object.keys(actual.tables))
		if (!(name in expected.tables)) problems.push(`table ${name} is not in the backup`);

	let secrets = 0;
	let opened = 0;
	const kvPart = progress.target.kind === "tenant" ? partOf(manifest, "kv", label) : undefined;
	if (kvPart !== undefined && target.tenant !== undefined) {
		const backedUp = new Map(
			(await readPart(store, kvPart))
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line) as { name: string; value: string })
				.map(({ name, value }) => [name, value]),
		);
		const restored = wranglerStore(deps, project, environment, target.tenant, target.kvLocation);
		const names = await restored.names();
		secrets = names.length;
		if (names.length !== backedUp.size || names.some((name) => !backedUp.has(name))) {
			problems.push(`the restored namespace holds ${names.length} secrets, the backup ${backedUp.size}`);
		}
		let differing = 0;
		for (const name of names) if ((await restored.get(name)) !== backedUp.get(name)) differing++;
		if (differing > 0) problems.push(`${differing} restored secrets differ from the backup's envelopes`);
		const vars = worker(project.workers.tenant, target.tenant.env, `tenant ${target.tenant.id}`).vars;
		const scope = { tenantId: target.tenant.id, environment: vars.TAKEBASE_ENV ?? "" };
		for (const version of kvPart.keyVersions) {
			const result = await verifySecrets({
				store: restored,
				keys: keyRing(environment.keysFile ?? "", target.tenant.id),
				scope,
				target: version,
			});
			opened += result.onTarget;
			if (result.rejected > 0 || result.unreadable > 0)
				problems.push(`${result.rejected + result.unreadable} restored secrets do not open with v${version}`);
		}
		if (opened !== backedUp.size) problems.push(`${opened} of ${backedUp.size} restored secrets opened`);
	}
	if (problems.length > 0) {
		throw new CliError(
			`The restore into ${shownTarget(project, environment, progress.database)} is NOT proved:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
			{
				hint: environment.remote
					? "Remote KV is eventually consistent: run the same command again in a minute to prove it again."
					: "Run the same command again to prove it again, or discard the target.",
			},
		);
	}
	const tables = Object.values(actual.tables);
	return { tables: tables.length, rows: tables.reduce((sum, table) => sum + table.rows, 0), secrets, opened };
};

// `wrangler d1 export` reads only `<config dir>/.wrangler/state` locally, so
// the restored state is exported from a copy beside a copy of the configuration.
const localExportConfig = (
	project: ProjectConfig,
	progress: RestoreProgress,
	temp: string,
	target: ReturnType<typeof targetWrangler>,
) => {
	cpSync(join(progress.database, "v3", "d1"), join(temp, ".wrangler", "state", "v3", "d1"), { recursive: true });
	writeFileSync(join(temp, "wrangler.jsonc"), readFileSync(join(target.dir, "wrangler.jsonc")));
	const env = target.tenant === undefined ? project.environments[progress.environment]?.globalEnv : target.tenant.env;
	return [...(env === undefined ? [] : ["--env", env]), "-c", join(temp, "wrangler.jsonc")];
};

// `--discard <restore id>`: removes a target this CLI created for a restore
// (half-made or proved) and its progress record. Only names in the record,
// only `<namePrefix>restore-*` names remotely and `.wrangler/restore-*`
// directories locally; never the source.
export const discardRestore = (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	restoreId: string,
	report: RestoreReport,
) => {
	const progress = readRestoreProgress(project, environment.name, restoreId);
	if (progress === null) throw new CliError(`No restore ${restoreId} is recorded for ${environment.name}`);
	const shown = (name: string | null) => shownTarget(project, environment, name ?? "");
	const prefix = environment.remote ? `${environment.namePrefix ?? ""}restore-` : "restore-";
	for (const name of [progress.database, progress.namespace]) {
		if (name === null) continue;
		const base = environment.remote ? name : (name.split("/").at(-1) ?? "");
		if (!base.startsWith(prefix) || (!environment.remote && !name.includes("/.wrangler/"))) {
			throw new CliError(`Refusing to discard ${name}: not a restore target`, { hint: "Nothing was changed." });
		}
		assertOwned(environment, "restore target", name);
	}
	if (environment.remote) {
		const run = (args: string[]) => deps.run(project.workers.global, "wrangler", args, cloudflareEnv(environment));
		if (progress.namespaceId !== null) {
			// The recorded id must still name the recorded restore namespace, never another one.
			const listed = listRemote(deps, project, environment, ["kv", "namespace", "list"]).find(
				(ns) => ns.id === progress.namespaceId,
			);
			if (listed !== undefined && listed.title !== progress.namespace) {
				throw new CliError(
					`Refusing to discard KV namespace ${progress.namespaceId}: it is "${String(listed.title)}"`,
					{
						hint: "The progress record does not match the account. Nothing was changed.",
					},
				);
			}
		}
		if (progress.namespaceId !== null) {
			const result = run(["kv", "namespace", "delete", "--namespace-id", progress.namespaceId, "--skip-confirmation"]);
			if (result.status !== 0 && !/not found|10013/i.test(result.output))
				throw fail(`wrangler kv namespace delete ${progress.namespace} failed`, result.output);
			report(`deleted KV namespace ${shown(progress.namespace)}`);
		}
		if (listRemote(deps, project, environment, ["d1", "list", "--json"]).some((db) => db.name === progress.database)) {
			const result = run(["d1", "delete", progress.database, "--skip-confirmation"]);
			if (result.status !== 0) throw fail(`wrangler d1 delete ${progress.database} failed`, result.output);
			report(`deleted D1 database ${shown(progress.database)}`);
		}
	} else {
		rmSync(progress.database, { recursive: true, force: true });
		report(`removed ${shown(progress.database)}`);
	}
	rmSync(progressPath(project, environment.name, restoreId), { force: true });
	return progress;
};
