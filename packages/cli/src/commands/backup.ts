import { parseCommandArgs } from "../args.ts";
import { CliError, type CliIo } from "../errors.ts";
import { loadProjectConfig, resolveEnvironment } from "../project-config.ts";
import { backupBucketOf, createBackup, createBucket, r2Store } from "../services/backup-export.ts";
import { type BackupManifest, type BackupScope, isBackupId } from "../services/backup-manifest.ts";
import { type BackupVerification, latestBackupId, listBackups, verifyBackup } from "../services/backups.ts";
import { checkAccount } from "../services/deployment.ts";
import { defaultRemoteDeps, type RemoteDeps } from "../services/remote-workers.ts";

const usage = `takebase backup init [--env <name>]
       takebase backup create (--tenant <id> | --global | --all) [--env <name>]
       takebase backup list [--env <name>]
       takebase backup verify (<backup-id> | --latest) [--env <name>]`;

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

Options:
  --tenant <id>   Back up one tenant (its D1 database and secrets)
  --global        Back up the global D1 database
  --all           Back up the global database and every tenant
  --latest        verify: the newest catalogued backup
  --env <name>    Environment from takebase.jsonc (default: local)
  -h, --help      Show this help

Each part is captured at its own time: a backup is not one atomic snapshot
across databases and KV. Data keys are never included: a restore needs the key
versions the manifest lists, from the keys file or the escrow. Locally, stop
the stack first (\`pnpm dev:stack:stop\`). Restore and prune are planned.
`;

const options = {
	env: { type: "string" },
	tenant: { type: "string" },
	global: { type: "boolean" },
	all: { type: "boolean" },
	latest: { type: "boolean" },
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

// Usage errors and planned subcommands fail synchronously; the work is asynchronous.
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
	if (subcommand === "restore" || subcommand === "prune") {
		throw new CliError(`\`takebase backup ${subcommand}\` is planned but not implemented yet`, {
			hint: "Run `takebase backup --help` to see what this version supports.",
		});
	}
	if (subcommand === undefined || !["init", "create", "list", "verify"].includes(subcommand) || extra.length > 0) {
		throw new CliError(`Usage: ${usage}`, { usage: true, hint: "Run `takebase backup --help`." });
	}
	const latest = values.latest === true;
	if (subcommand === "verify" ? (id !== undefined) === latest : id !== undefined || latest) {
		throw new CliError(subcommand === "verify" ? "backup verify needs a backup id or --latest" : `Usage: ${usage}`, {
			usage: true,
		});
	}
	if (subcommand !== "create" && (values.tenant !== undefined || values.global === true || values.all === true)) {
		throw new CliError("--tenant, --global and --all are for backup create only", { usage: true });
	}
	return runBackup(io, deps, values, subcommand, id);
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
