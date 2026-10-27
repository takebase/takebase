import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { CliError, type CliIo } from "../errors.ts";
import { loadProjectConfig, resolveEnvironment } from "../project-config.ts";
import { readSecretsFile } from "../secrets-file.ts";
import { assertOwned, cloudflareEnv, workerEnvironment } from "../services/environment.ts";
import { redactText } from "../services/redact.ts";
import { createTailParser, formatTailEvent } from "../services/tail.ts";

// `takebase logs`: live, redacted request and error logs of one deployed Worker,
// streamed from `wrangler tail`. Nothing is stored; history stays in the
// Cloudflare dashboard's Workers Logs.

const usage = "takebase logs <global|app|tenant-id> --env <remote env> [--for <seconds>] [--errors]";

const help = `Stream live request and error logs of one deployed Worker, redacted.

Usage: ${usage}

Options:
  --env <name>       Remote environment from takebase.jsonc (required)
  --for <seconds>    Stop after this many seconds (default: until Ctrl-C)
  --errors           Only requests that failed (wrangler tail --status error)
  -h, --help         Show this help

Each request prints one line (time, outcome, method, path without its query,
status, request id) followed by what the Worker logged. Headers, query strings
and bodies are never printed; tokens, passwords, secrets and email addresses
are masked. Locally, \`takebase dev\` prints the Workers' logs itself.
`;

const options = {
	env: { type: "string" },
	for: { type: "string" },
	errors: { type: "boolean" },
	help: { type: "boolean", short: "h" },
} as const;

export const logsCommand = async (args: string[], io: CliIo) => {
	const { values, positionals } = parseCommandArgs("logs", args, options);
	if (values.help === true) {
		io.stdout(help);
		return 0;
	}
	const [target, ...extra] = positionals;
	if (target === undefined || extra.length > 0) {
		throw new CliError(target === undefined ? "Missing Worker" : `Unexpected arguments: ${extra.join(" ")}`, {
			usage: true,
			hint: `Usage: ${usage}`,
		});
	}
	const seconds = values.for === undefined ? undefined : Number(values.for);
	if (seconds !== undefined && !(Number.isInteger(seconds) && seconds > 0 && seconds <= 3600)) {
		throw new CliError("--for takes whole seconds from 1 to 3600", { usage: true, hint: `Usage: ${usage}` });
	}
	const project = loadProjectConfig(io.cwd);
	const environment = resolveEnvironment(project, values.env);
	if (!environment.remote) {
		throw new CliError(`Environment "${environment.name}" is local; \`takebase logs\` tails deployed Workers`, {
			usage: true,
			hint: "Locally, `takebase dev` prints every Worker's log lines.",
		});
	}
	const tenant = environment.tenants.find(({ id }) => id === target);
	const [dir, env] =
		target === "global"
			? [project.workers.global, environment.globalEnv]
			: target === "app"
				? [project.workers.app, environment.appEnv]
				: tenant
					? [project.workers.tenant, tenant.env]
					: [undefined, undefined];
	if (dir === undefined) {
		throw new CliError(`Unknown Worker "${target}"`, {
			usage: true,
			hint: `Use global, app or a tenant: ${environment.tenants.map(({ id }) => id).join(", ")}.`,
		});
	}
	const worker = workerEnvironment(dir, env);
	if (!worker) throw new CliError(`No Wrangler environment for ${target}`, { hint: "Run `takebase doctor`." });
	assertOwned(environment, "Worker", worker.workerName);
	const bin = join(dir, "node_modules", ".bin", "wrangler");
	if (!existsSync(bin))
		throw new CliError(`wrangler is not installed in ${dir}`, { hint: "Run `pnpm install` first." });

	io.stdout(
		`Tailing ${worker.workerName}${values.errors === true ? " (errors only)" : ""}${seconds === undefined ? "; Ctrl-C stops" : ` for ${seconds} s`}. Output is redacted.\n`,
	);
	const child = spawn(
		bin,
		["tail", worker.workerName, "--format", "json", ...(values.errors === true ? ["--status", "error"] : [])],
		{
			cwd: dir,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				NO_COLOR: "1",
				FORCE_COLOR: "0",
				WRANGLER_SEND_METRICS: "false",
				...cloudflareEnv(environment),
			},
		},
	);
	// Known secret values are masked as well; they are never printed or kept.
	const secrets =
		environment.secretsFile === undefined ? [] : Object.values(readSecretsFile(environment.secretsFile).values);
	let events = 0;
	const parse = createTailParser((event) => {
		events++;
		io.stdout(`${formatTailEvent(event, secrets).join("\n")}\n`);
	});
	child.stdout.setEncoding("utf8").on("data", parse);
	// Wrangler's own messages, kept only for a redacted error hint.
	let errors = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		errors = `${errors}${chunk}`.slice(-4000);
	});
	let stopped = false;
	const stop = () => {
		stopped = true;
		child.kill("SIGINT");
	};
	const timer = seconds === undefined ? undefined : setTimeout(stop, seconds * 1000);
	process.on("SIGINT", stop);
	const code = await new Promise<number | null>((resolve) => child.on("exit", (exit) => resolve(exit)));
	if (timer) clearTimeout(timer);
	process.off("SIGINT", stop);
	io.stdout(`Stopped after ${events} event(s).\n`);
	// Wrangler ending by itself with an error (login, account, unknown Worker).
	if (!stopped && code !== 0) {
		throw new CliError(`wrangler tail ended with ${code}`, {
			hint: redactText(errors.trim().split("\n").slice(-5).join("\n")) || "Check `takebase doctor --env`.",
		});
	}
	return 0;
};
