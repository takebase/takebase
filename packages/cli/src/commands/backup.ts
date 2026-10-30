import { parseCommandArgs } from "../args.ts";
import { CliError, type CliIo } from "../errors.ts";
import { loadProjectConfig, resolveEnvironment } from "../project-config.ts";
import { backupBucketOf, createBackup, createBucket, r2Store, refuseRunningStack } from "../services/backup-export.ts";
import { type BackupManifest, type BackupScope, isBackupId } from "../services/backup-manifest.ts";
import { executePrune, pendingPrunes, planPrune } from "../services/backup-prune.ts";
import { type BackupVerification, latestBackupId, listBackups, verifyBackup } from "../services/backups.ts";
import { checkAccount } from "../services/deployment.ts";
import { defaultRemoteDeps, type RemoteDeps } from "../services/remote-workers.ts";
import {
	planRestore,
	type RestorePlan,
	type RestoreTarget,
	restoreIdOf,
	shownTarget,
	targetLabel,
} from "../services/restore.ts";
import { discardRestore, executeRestore, listRestores, readRestoreProgress } from "../services/restore-execution.ts";

const usage = `takebase backup init [--env <name>]
       takebase backup create (--tenant <id> | --global | --all) [--env <name>]
       takebase backup list [--env <name>]
       takebase backup verify (<backup-id> | --latest) [--env <name>]
       takebase backup restore (<backup-id> | --latest) (--tenant <id> | --global) (--dry-run | --confirm <env>) [--env <name>]
       takebase backup restore --discard <restore-id> --confirm <env> [--env <name>]
       takebase backup prune --keep <n> (--plan | --confirm <env>) [--env <name>]`;

const help = `Create, list and verify versioned backups in the environment's private R2 bucket.

Usage: ${usage}

Commands:
  init     Create the environment's backup bucket (remote only; private, never public)
  create   Export the selected D1 databases, each tenant's encrypted secrets
           (ciphertext only) and configuration metadata, then write a manifest
           with every object's size and SHA-256, and verify the result
  list     Every catalogued backup, newest first, each verified again now
  verify   Check one backup: every object present and intact, the manifest's
           checksum, and each export's migration history and secret count
  restore  Recover one tenant or the global database into a new, isolated D1
           database (and KV namespace), never the source. Every check runs
           first: the backup verifies, belongs to this environment and target,
           its migrations are the repository's, its data keys open its
           secrets, and the isolated target does not exist yet. --dry-run
           stops there. --confirm <env> then creates the target, imports the
           database and the ciphertext secrets, and proves the result: the
           same schema and rows in every table, the same envelopes, each
           opened by the tenant's key. Rerun the same command to continue an
           interrupted restore; --discard removes a restore target
  prune    Delete old backups, keeping per subject (all, global, each tenant)
           the newest --keep verified ones, always the newest verified one,
           and any backup a recorded restore refers to. FAILED backups never
           count as kept. --plan lists what would go and why the rest stays

Options:
  --tenant <id>   Back up one tenant (its D1 database and secrets)
  --global        Back up the global D1 database
  --all           Back up the global database and every tenant
  --latest        verify, restore: the newest catalogued backup
  --dry-run       restore: check and print the plan; create and change nothing
  --confirm <env> restore: the environment's name, to create and fill the target
  --discard <id>  restore: remove that restore's target and progress record
  --keep <n>      prune: verified backups to keep per subject (at least 1)
  --plan          prune: list the decisions; delete nothing
  --env <name>    Environment from takebase.jsonc (default: local)
  -h, --help      Show this help

Each part is captured at its own time: a backup is not one atomic snapshot
across databases and KV. Data keys are never included: a restore needs the key
versions the manifest lists, from the keys file or the escrow. Locally, stop
the stack first (\`pnpm dev:stack:stop\`).
`;

const options = {
	env: { type: "string" },
	tenant: { type: "string" },
	global: { type: "boolean" },
	all: { type: "boolean" },
	latest: { type: "boolean" },
	"dry-run": { type: "boolean" },
	confirm: { type: "string" },
	discard: { type: "string" },
	keep: { type: "string" },
	plan: { type: "boolean" },
	help: { type: "boolean", short: "h" },
} as const;

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

const describeParts = (manifest: BackupManifest) =>
	manifest.parts.map((part) => {
		const where = `  ${part.kind.padEnd(6)} ${part.target.padEnd(18)} ${kib(part.object.bytes).padStart(10)}  captured ${part.capturedAt}`;
		if (part.kind === "d1")
			return `${where}\n         schema ${part.schemaVersion ?? "(none)"}, ${part.migrations.length} migrations`;
		if (part.kind === "kv") {
			return `${where}\n         ${part.count} ciphertext secrets, key versions ${part.keyVersions.map((v) => `v${v}`).join(", ") || "(none)"}`;
		}
		return where;
	});

const reportVerification = (io: CliIo, verification: BackupVerification) => {
	if (verification.status === "verified") {
		io.stdout(`Backup ${verification.backupId}: verified\n`);
		return 0;
	}
	io.stdout(`Backup ${verification.backupId}: FAILED verification\n`);
	for (const problem of verification.problems) io.stdout(`  - ${problem}\n`);
	return 1;
};

const selectionOf = (values: { tenant?: string; global?: boolean; all?: boolean }) => {
	const chosen = [values.tenant !== undefined, values.global === true, values.all === true].filter(Boolean).length;
	if (chosen !== 1)
		throw new CliError("backup create needs exactly one of --tenant <id>, --global or --all", { usage: true });
	const scope: BackupScope = values.tenant !== undefined ? "tenant" : values.global === true ? "global" : "all";
	return { scope, tenantId: values.tenant };
};

// Usage errors fail synchronously; the work is asynchronous.
export const backupCommand = (
	args: string[],
	io: CliIo,
	deps: RemoteDeps = defaultRemoteDeps,
): number | Promise<number> => {
	const { values, positionals } = parseCommandArgs("backup", args, options);
	if (values.help === true) {
		io.stdout(help);
		return 0;
	}
	const [subcommand, id, ...extra] = positionals;
	if (
		subcommand === undefined ||
		!["init", "create", "list", "verify", "restore", "prune"].includes(subcommand) ||
		extra.length > 0
	) {
		throw new CliError(`Usage: ${usage}`, { usage: true, hint: "Run `takebase backup --help`." });
	}
	const latest = values.latest === true;
	if ((values.keep !== undefined || values.plan === true) && subcommand !== "prune") {
		throw new CliError("--keep and --plan are for backup prune only", { usage: true });
	}
	if (subcommand === "prune") {
		if (id !== undefined || latest || values.tenant !== undefined || values.global === true || values.all === true) {
			throw new CliError(`Usage: ${usage}`, { usage: true });
		}
		if (values.keep === undefined || (values.plan === true) === (values.confirm !== undefined)) {
			throw new CliError("backup prune needs --keep <n> and exactly one of --plan or --confirm <env>", {
				usage: true,
			});
		}
		return runPrune(io, deps, values, Number(values.keep));
	}
	if (subcommand === "restore") {
		const confirmed = values.confirm !== undefined;
		if (values.discard !== undefined) {
			if (id !== undefined || latest || values.tenant !== undefined || values.global === true || !confirmed) {
				throw new CliError("backup restore --discard <restore-id> needs --confirm <env> and nothing else", {
					usage: true,
				});
			}
			return runDiscard(io, deps, values, values.discard);
		}
		if ((values["dry-run"] === true) === confirmed) {
			throw new CliError("backup restore needs exactly one of --dry-run or --confirm <env>", { usage: true });
		}
		if ((id !== undefined) === latest || values.all === true) {
			throw new CliError("backup restore needs a backup id or --latest, and one of --tenant <id> or --global", {
				usage: true,
			});
		}
		return runRestore(io, deps, values, id, restoreTargetOf(values));
	}
	if (values["dry-run"] === true || values.confirm !== undefined || values.discard !== undefined) {
		throw new CliError("--dry-run, --confirm and --discard are for backup restore and prune only", { usage: true });
	}
	if (subcommand === "verify" ? (id !== undefined) === latest : id !== undefined || latest) {
		throw new CliError(subcommand === "verify" ? "backup verify needs a backup id or --latest" : `Usage: ${usage}`, {
			usage: true,
		});
	}
	if (subcommand !== "create" && (values.tenant !== undefined || values.global === true || values.all === true)) {
		throw new CliError("--tenant, --global and --all are for backup create and restore only", { usage: true });
	}
	return runBackup(io, deps, values, subcommand, id);
};

const restoreTargetOf = (values: { tenant?: string; global?: boolean }): RestoreTarget => {
	if ((values.tenant !== undefined) === (values.global === true)) {
		throw new CliError("backup restore needs exactly one of --tenant <id> or --global", { usage: true });
	}
	return values.tenant === undefined ? { kind: "global" } : { kind: "tenant", tenantId: values.tenant };
};

const describePlan = (plan: RestorePlan, shown: (name: string) => string) => {
	const lines = [
		`Restore plan for ${targetLabel(plan.target)} from backup ${plan.backupId} (${plan.environment}):`,
		`  into   ${shown(plan.database)}${plan.namespace === null || plan.namespace === plan.database ? "" : ` and ${shown(plan.namespace)}`} (new, isolated; the source is never written)`,
		`  schema ${plan.schemaVersion ?? "(none)"}`,
		...plan.tables.map(({ name, rows }) => `  table  ${name.padEnd(28)} ${String(rows).padStart(8)} rows`),
	];
	if (plan.target.kind === "tenant") {
		lines.push(
			`  ${plan.secrets} ciphertext secrets, key versions ${plan.keyVersions.map((v) => `v${v}`).join(", ") || "(none)"}`,
		);
	}
	return lines;
};

// The environment named twice, like deploy: a restore creates resources.
const confirmedEnvironment = (io: CliIo, values: { env?: string; confirm?: string }) => {
	const project = loadProjectConfig(io.cwd);
	const environment = resolveEnvironment(project, values.env);
	if (values.confirm !== undefined && values.confirm !== environment.name) {
		throw new CliError(`--confirm ${values.confirm} does not name environment "${environment.name}"`, {
			usage: true,
			hint: `Pass --confirm ${environment.name}. Nothing was changed.`,
		});
	}
	return { project, environment };
};

const runRestore = async (
	io: CliIo,
	deps: RemoteDeps,
	values: { env?: string; confirm?: string; "dry-run"?: boolean },
	id: string | undefined,
	target: RestoreTarget,
) => {
	if (id !== undefined && !isBackupId(id)) throw new CliError(`"${id}" is not a backup id`, { usage: true });
	const { project, environment } = confirmedEnvironment(io, values);
	const dryRun = values["dry-run"] === true;
	if (environment.remote) checkAccount(deps, project, environment);
	else if (!dryRun) await refuseRunningStack(deps, project, environment);
	const store = r2Store(deps, project, environment);
	const backupId = id ?? (await latestBackupId(store));
	if (backupId === undefined) throw new CliError(`No backups in ${backupBucketOf(environment)} (${environment.name})`);
	const restoreId = restoreIdOf(backupId, target);
	const progress = readRestoreProgress(project, environment.name, restoreId);
	if (progress?.step === "proved") {
		io.stdout(
			`Restore ${restoreId} of ${targetLabel(target)} is already done and proved in ${shownTarget(project, environment, progress.database)}.\n`,
		);
		io.stdout(`Remove it with \`takebase backup restore --discard ${restoreId} --confirm ${environment.name}\`.\n`);
		return 0;
	}
	const plan = await planRestore(deps, project, environment, store, backupId, target, { resuming: progress !== null });
	const shown = (name: string) => shownTarget(project, environment, name);
	for (const line of describePlan(plan, shown)) io.stdout(`${line}\n`);
	if (progress !== null) io.stdout(`  continuing restore ${restoreId} after step "${progress.step}"\n`);
	if (plan.problems.length > 0) {
		io.stdout("Restore BLOCKED:\n");
		for (const problem of plan.problems) io.stdout(`  - ${problem}\n`);
		io.stdout(`${dryRun ? "Dry run: n" : "N"}othing was created or changed.\n`);
		return 1;
	}
	if (dryRun) {
		io.stdout("Dry run: every check passed; nothing was created or changed.\n");
		return 0;
	}
	const { manifest } = await verifyBackup(store, backupId);
	if (manifest === null) throw new CliError(`Backup ${backupId} no longer verifies; nothing more was changed`);
	const done = await executeRestore(deps, project, environment, store, manifest, plan, (line) =>
		io.stdout(`  ${line}\n`),
	);
	const proof = done.proof;
	io.stdout(
		`Restore ${restoreId}: proved in ${shown(done.database)}${proof === null ? "" : `: ${proof.tables} tables, ${proof.rows} rows equal the backup's${done.target.kind === "tenant" ? `; ${proof.opened} of ${proof.secrets} secrets opened` : ""}`}.\n`,
	);
	io.stdout("The source database, KV namespace and backup were not written.\n");
	return 0;
};

const runDiscard = async (
	io: CliIo,
	deps: RemoteDeps,
	values: { env?: string; confirm?: string },
	restoreId: string,
) => {
	const { project, environment } = confirmedEnvironment(io, values);
	if (environment.remote) checkAccount(deps, project, environment);
	else await refuseRunningStack(deps, project, environment);
	discardRestore(deps, project, environment, restoreId, (line) => io.stdout(`  ${line}\n`));
	io.stdout(`Restore ${restoreId} discarded; the source and the backup were not touched.\n`);
	return 0;
};

const runPrune = async (
	io: CliIo,
	deps: RemoteDeps,
	values: { env?: string; confirm?: string; plan?: boolean },
	keep: number,
) => {
	const { project, environment } = confirmedEnvironment(io, values);
	if (environment.remote) checkAccount(deps, project, environment);
	const store = r2Store(deps, project, environment);
	const inUse = new Set(listRestores(project, environment.name).map(({ backupId }) => backupId));
	const decisions = await planPrune(store, keep, inUse);
	const bucket = backupBucketOf(environment);
	io.stdout(`Prune plan for ${bucket} (${environment.name}), keeping ${keep} verified per subject:\n`);
	for (const { entry, action, reason } of decisions) {
		io.stdout(`  ${action === "keep" ? "keep  " : "DELETE"} ${entry.backupId.padEnd(40)} ${reason}\n`);
	}
	const pending = await pendingPrunes(store);
	for (const backupId of pending) io.stdout(`  DELETE ${backupId.padEnd(40)} an interrupted prune, to finish\n`);
	const count = decisions.filter(({ action }) => action === "delete").length + pending.length;
	if (values.plan === true) {
		io.stdout(`Plan only: ${count} backup(s) would be deleted; nothing was changed.\n`);
		return 0;
	}
	const deleted = await executePrune(store, decisions, (line) => io.stdout(`  ${line}\n`));
	io.stdout(`Pruned ${deleted.length} backup(s); the catalog never listed a backup without its objects.\n`);
	return 0;
};

const runBackup = async (
	io: CliIo,
	deps: RemoteDeps,
	values: { env?: string; tenant?: string; global?: boolean; all?: boolean; latest?: boolean },
	subcommand: string,
	id: string | undefined,
) => {
	const latest = values.latest === true;
	const project = loadProjectConfig(io.cwd);
	const environment = resolveEnvironment(project, values.env);
	const bucket = backupBucketOf(environment);
	if (environment.remote) checkAccount(deps, project, environment);

	if (subcommand === "init") {
		if (!environment.remote) {
			io.stdout(`Local backups use the bucket ${bucket} in local R2; it needs no creation.\n`);
			return 0;
		}
		const result = createBucket(deps, project, environment);
		io.stdout(
			`${result.created ? "Created" : "Kept the existing"} private R2 bucket ${result.bucket} (${environment.name}).\n`,
		);
		return 0;
	}
	if (subcommand === "create") {
		const { manifest, verification } = await createBackup(deps, project, environment, selectionOf(values));
		io.stdout(`Backup ${manifest.backupId} of ${environment.name} in ${bucket}:\n`);
		for (const line of describeParts(manifest)) io.stdout(`${line}\n`);
		io.stdout("  Each part was captured at its own time; data keys are not included.\n");
		return reportVerification(io, verification);
	}
	const store = r2Store(deps, project, environment);
	if (subcommand === "verify") {
		const backupId = latest ? await latestBackupId(store) : (id ?? "");
		if (backupId === undefined) throw new CliError(`No backups in ${bucket} (${environment.name})`);
		if (!isBackupId(backupId)) throw new CliError(`"${backupId}" is not a backup id`, { usage: true });
		return reportVerification(io, await verifyBackup(store, backupId));
	}
	const listed = await listBackups(store);
	if (listed.length === 0) {
		io.stdout(`No backups in ${bucket} (${environment.name}).\n`);
		return 0;
	}
	io.stdout(`Backups in ${bucket} (${environment.name}), newest first, verified now:\n`);
	for (const { entry, verification } of listed) {
		io.stdout(
			`  ${entry.backupId.padEnd(40)} ${entry.scope.padEnd(7)} ${verification.status === "verified" ? "verified" : "FAILED"}\n`,
		);
		for (const problem of verification.problems) io.stdout(`      - ${problem}\n`);
	}
	return listed.every(({ verification }) => verification.status === "verified") ? 0 : 1;
};
