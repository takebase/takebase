import { join } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { CliError, type CliIo } from "../errors.ts";
import {
	type EnvironmentConfig,
	loadProjectConfig,
	type ProjectConfig,
	resolveEnvironment,
} from "../project-config.ts";
import { readSecretsFile } from "../secrets-file.ts";
import { checkAccount } from "../services/deployment.ts";
import { tenantEndpoint } from "../services/endpoints.ts";
import { cloudflareEnv, parseToolJson } from "../services/environment.ts";
import {
	initKey,
	keysFileOf,
	remoteSecretNames,
	secretsTarget,
	storedKeyName,
	workerKeyName,
} from "../services/key-installation.ts";
import { activeVersion, recoverTenantKeys, rotateKey, rotationOf } from "../services/key-lifecycle.ts";
import { defaultRemoteDeps, getUrl, type RemoteDeps } from "../services/remote-workers.ts";
import { outputTail } from "../worker-target.ts";

const usage = `takebase secrets init <tenant> [--env <name>] [--stdin]
       takebase secrets rotate <tenant> [--env <name>] [--limit <n>] [--accept-destructive <tenant>:v<n>]
       takebase secrets recover <tenant> [--env <name>]
       takebase secrets check [<tenant>] [--env <name>]
       takebase secrets status [<tenant>] [--env <name>]`;

const help = `Initialise and inspect each tenant's encrypted secrets (AES-256-GCM in KV).

Usage: ${usage}

Commands:
  init     Create the tenant's data key (or read it from --stdin), deposit it in
           the environment's escrow, store it in its keys file (mode 600) and,
           remotely, install it as the tenant Worker's secret. Refuses when a
           key is already installed.
  rotate   Replace the tenant's data key: create and escrow a new one, activate
           it, re-encrypt every secret, verify, then retire the old key. Rerun
           to continue an interrupted or --limit-ed rotation.
  recover  Restore the tenant's lost key from the escrow, after proving it
           opens the stored secrets; remotely, reinstall it on the Worker
  check    Ask each tenant Worker whether its key opens its secrets (readiness)
  status   Key presence, any unfinished rotation, and the stored secrets'
           metadata: never a value

Options:
  --env <name>                Environment from takebase.jsonc (default: local)
  --stdin                     Read the key (base64 of 32 bytes) from standard input
  --limit <n>                 Re-encrypt at most n secrets in this run
  --accept-destructive <t>:v<n>
                              Retire key v<n> of tenant <t> even though some
                              secrets do not open with the new key (they may be lost)
  -h, --help                  Show this help

Keys are never accepted as arguments and never printed. Keep the escrow outside
this machine: ciphertext alone cannot be recovered. Locally, stop the stack
before rotate and restart it after init, rotate or recover so the tenant Worker
loads its key.
`;

const options = {
	env: { type: "string" },
	stdin: { type: "boolean" },
	limit: { type: "string" },
	"accept-destructive": { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;

const tenantIds = (environment: EnvironmentConfig, id: string | undefined) =>
	id === undefined ? environment.tenants.map((tenant) => tenant.id) : [id];

const init = async (
	io: CliIo,
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	id: string,
	stdin: boolean,
) => {
	if (stdin && io.stdin === undefined) throw new CliError("This caller cannot read standard input");
	if (environment.remote) checkAccount(deps, project, environment);
	const result = await initKey(deps, project, environment, id, stdin ? io.stdin : undefined);
	const name = workerKeyName(result.version);
	const what =
		result.source === "stored"
			? "Installed the stored"
			: result.source === "stdin"
				? "Stored the given"
				: "Generated a new";
	io.stdout(
		`${what} data key ${name} for tenant ${result.tenantId} (${environment.name}); the key is never printed.\n`,
	);
	io.stdout(`  Stored as ${storedKeyName(result.tenantId, result.version)} in ${result.keysFile} (mode 600).\n`);
	io.stdout(
		result.installedOn === null
			? "  Restart the local stack (`pnpm dev:stack`) so the tenant Worker loads it.\n"
			: `  Installed as the Worker secret ${name} on ${result.installedOn}.\n`,
	);
	io.stdout(
		environment.escrowDir === undefined
			? "  Keep an escrow copy of the keys file elsewhere: without the key, its secrets are lost.\n"
			: `  Deposited first in the escrow directory ${environment.escrowDir}.\n`,
	);
	return 0;
};

const rotate = async (
	io: CliIo,
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	id: string,
	limitText: string | undefined,
	acceptDestructive: string | undefined,
) => {
	const limit = limitText === undefined ? undefined : Number(limitText);
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
		throw new CliError("--limit must be a positive whole number", { usage: true });
	}
	if (environment.remote) checkAccount(deps, project, environment);
	const progress = await rotateKey(deps, project, environment, id, {
		limit,
		acceptDestructive,
		report: (line) => io.stdout(`${line}\n`),
	});
	io.stdout(
		progress.phase === "retired"
			? "\nRotation complete; keys and values are never printed.\n"
			: `\nRotation of tenant ${id} is at "${progress.phase}"; run the same command again to continue.\n`,
	);
	return 0;
};

const recover = async (
	io: CliIo,
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	id: string,
) => {
	if (environment.remote) checkAccount(deps, project, environment);
	for (const result of await recoverTenantKeys(deps, project, environment, id)) {
		const name = workerKeyName(result.version);
		io.stdout(
			result.outcome === "restored"
				? `Restored ${name} for tenant ${result.tenantId} from the escrow: it opens all ${result.opened} secret(s) stored under it.\n`
				: `${name} for tenant ${result.tenantId} is already in the keys file; nothing restored.\n`,
		);
		if (result.installed) io.stdout(`  Installed it again as the Worker secret ${name}.\n`);
	}
	if (!environment.remote) io.stdout("  Restart the local stack (`pnpm dev:stack`) so the tenant Worker loads it.\n");
	return 0;
};

const check = async (
	io: CliIo,
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	id?: string,
) => {
	let failed = 0;
	for (const tenant of tenantIds(environment, id)) {
		const { url } = tenantEndpoint(project, environment, tenant);
		const answer = await getUrl(deps, `${url}/health/ready`);
		let state = "unreachable";
		try {
			state = String((JSON.parse(answer.body) as { checks?: { secrets?: unknown } }).checks?.secrets ?? "missing");
		} catch {}
		if (state !== "ok") failed++;
		io.stdout(`${state === "ok" ? "ok  " : "FAIL"} tenant ${tenant} secrets: ${state}\n`);
	}
	io.stdout(failed === 0 ? "\nEvery tenant's key opens its secrets.\n" : `\n${failed} tenant(s) not ready.\n`);
	return failed === 0 ? 0 : 1;
};

const status = (io: CliIo, deps: RemoteDeps, project: ProjectConfig, environment: EnvironmentConfig, id?: string) => {
	if (environment.remote) checkAccount(deps, project, environment);
	for (const tenantId of tenantIds(environment, id)) {
		const { tenant } = secretsTarget(project, environment, tenantId);
		const version = activeVersion(project, environment, tenant.id);
		const name = workerKeyName(version);
		const stored = readSecretsFile(keysFileOf(environment)).values[storedKeyName(tenant.id, version)] !== undefined;
		io.stdout(`Tenant ${tenant.id} (${environment.name}), data key ${name}:\n`);
		io.stdout(`  keys file: ${stored ? "stored" : "missing"}\n`);
		const rotation = rotationOf(environment, tenant.id);
		if (rotation !== null && rotation.phase !== "retired") {
			io.stdout(`  rotation: v${rotation.from} -> v${rotation.to}, at "${rotation.phase}"; rerun \`secrets rotate\`\n`);
		}
		if (environment.remote) {
			const installed = remoteSecretNames(deps, project, environment, tenant.env).includes(name);
			io.stdout(`  Worker secret: ${installed ? "installed" : "missing"}\n`);
		}
		const location = environment.remote
			? ["--remote"]
			: ["--local", "--persist-to", join(project.workers.tenant, ".wrangler", `state-${tenant.id}`)];
		const result = deps.run(
			project.workers.tenant,
			"wrangler",
			["kv", "key", "list", "--binding", "SECRETS", "--env", tenant.env, "--prefix", "secret/", ...location],
			cloudflareEnv(environment),
		);
		const keys = parseToolJson(result.stdout);
		if (result.status !== 0 || !Array.isArray(keys)) {
			throw new CliError(`wrangler kv key list failed:\n${outputTail(result.output)}`);
		}
		io.stdout(`  stored secrets: ${keys.length}\n`);
		for (const entry of keys as { name?: unknown; metadata?: { kv?: unknown; updated?: unknown } }[]) {
			io.stdout(
				`    ${String(entry.name).replace(/^secret\//, "")}  key v${String(entry.metadata?.kv ?? "?")}  updated ${String(entry.metadata?.updated ?? "?")}\n`,
			);
		}
	}
	return 0;
};

export const secretsCommand = async (args: string[], io: CliIo, deps: RemoteDeps = defaultRemoteDeps) => {
	const { values, positionals } = parseCommandArgs("secrets", args, options);
	if (values.help === true) {
		io.stdout(help);
		return 0;
	}
	const [subcommand, id, ...extra] = positionals;
	if (
		subcommand === undefined ||
		!["init", "rotate", "recover", "check", "status"].includes(subcommand) ||
		extra.length > 0
	) {
		throw new CliError(`Usage: ${usage}`, { usage: true, hint: "Run `takebase secrets --help`." });
	}
	if (["init", "rotate", "recover"].includes(subcommand) && id === undefined) {
		throw new CliError(`secrets ${subcommand} needs a tenant id`, { usage: true });
	}
	if ((values.limit !== undefined || values["accept-destructive"] !== undefined) && subcommand !== "rotate") {
		throw new CliError("--limit and --accept-destructive are for secrets rotate only", { usage: true });
	}
	if (values.stdin === true && subcommand !== "init")
		throw new CliError("--stdin is for secrets init only", { usage: true });
	const project = loadProjectConfig(io.cwd);
	const environment = resolveEnvironment(project, values.env);
	if (subcommand === "init") return init(io, deps, project, environment, id ?? "", values.stdin === true);
	if (subcommand === "rotate") {
		return rotate(io, deps, project, environment, id ?? "", values.limit, values["accept-destructive"]);
	}
	if (subcommand === "recover") return recover(io, deps, project, environment, id ?? "");
	if (subcommand === "check") return check(io, deps, project, environment, id);
	return status(io, deps, project, environment, id);
};
