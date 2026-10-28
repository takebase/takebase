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
import { defaultRemoteDeps, getUrl, type RemoteDeps } from "../services/remote-workers.ts";
import { outputTail } from "../worker-target.ts";

const usage = `takebase secrets init <tenant> [--env <name>] [--stdin]
       takebase secrets check [<tenant>] [--env <name>]
       takebase secrets status [<tenant>] [--env <name>]`;

const help = `Initialise and inspect each tenant's encrypted secrets (AES-256-GCM in KV).

Usage: ${usage}

Commands:
  init     Create the tenant's data key (or read it from --stdin), store it in the
           environment's keys file (mode 600) and, remotely, install it as the
           tenant Worker's secret. Refuses when a key is already installed.
  check    Ask each tenant Worker whether its key opens its secrets (readiness)
  status   Key presence and the stored secrets' metadata: never a value

Options:
  --env <name>   Environment from takebase.jsonc (default: local)
  --stdin        Read the key (base64 of 32 bytes) from standard input
  -h, --help     Show this help

Keys are never accepted as arguments and never printed. Keep an escrow copy of
the keys file outside this machine: ciphertext alone cannot be recovered.
Locally, restart \`takebase dev\` after init so the tenant Worker loads its key.
`;

const options = {
	env: { type: "string" },
	stdin: { type: "boolean" },
	help: { type: "boolean", short: "h" },
} as const;

const tenantIds = (environment: EnvironmentConfig, id: string | undefined) =>
	id === undefined ? environment.tenants.map((tenant) => tenant.id) : [id];

const init = (
	io: CliIo,
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	id: string,
	stdin: boolean,
) => {
	if (stdin && io.stdin === undefined) throw new CliError("This caller cannot read standard input");
	if (environment.remote) checkAccount(deps, project, environment);
	const result = initKey(deps, project, environment, id, stdin ? io.stdin : undefined);
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
	io.stdout("  Keep an escrow copy of the keys file elsewhere: without the key, its secrets are lost.\n");
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
		const { tenant, version } = secretsTarget(project, environment, tenantId);
		const name = workerKeyName(version);
		const stored = readSecretsFile(keysFileOf(environment)).values[storedKeyName(tenant.id, version)] !== undefined;
		io.stdout(`Tenant ${tenant.id} (${environment.name}), data key ${name}:\n`);
		io.stdout(`  keys file: ${stored ? "stored" : "missing"}\n`);
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
	if (subcommand === undefined || !["init", "check", "status"].includes(subcommand) || extra.length > 0) {
		throw new CliError(`Usage: ${usage}`, { usage: true, hint: "Run `takebase secrets --help`." });
	}
	if (subcommand === "init" && id === undefined) throw new CliError("secrets init needs a tenant id", { usage: true });
	if (values.stdin === true && subcommand !== "init")
		throw new CliError("--stdin is for secrets init only", { usage: true });
	const project = loadProjectConfig(io.cwd);
	const environment = resolveEnvironment(project, values.env);
	if (subcommand === "init") return init(io, deps, project, environment, id ?? "", values.stdin === true);
	if (subcommand === "check") return check(io, deps, project, environment, id);
	return status(io, deps, project, environment, id);
};
