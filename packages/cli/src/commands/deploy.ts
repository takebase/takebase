import { parseCommandArgs } from "../args.ts";
import { CliError, type CliIo } from "../errors.ts";
import { loadProjectConfig, resolveEnvironment } from "../project-config.ts";
import { buildEnvironment, type DeployStep, deployEnvironment } from "../services/deployment.ts";
import { defaultRemoteDeps } from "../services/remote-workers.ts";

const deployUsage = "takebase deploy --env <name> (--plan | --confirm <name>)";

const deployHelp = `Deploy one remote environment: global migrations and Worker, every registered
active tenant (migrations and Worker), then the app.

Usage: ${deployUsage}

Options:
  --env <name>      Remote environment from takebase.jsonc
  --plan            Read-only: show what deploy would run and change nothing
  --confirm <name>  Repeat the environment name to deploy it
  -h, --help        Show this help

Deploy refuses any Worker or database name outside the environment's prefix
and a Cloudflare login that cannot use the environment's account, before any
change. It stops at the first failure; every step is safe to run again.
Tenants are provisioned with \`takebase tenant provision\`, never by deploy.
`;

const buildUsage = "takebase build [--env <name>]";

const buildHelp = `Bundle every Worker of one environment without uploading it, then build the
app with that environment's settings.

Usage: ${buildUsage}

Options:
  --env <name>  Environment from takebase.jsonc (default: local)
  -h, --help    Show this help

Nothing is uploaded and no account is used (\`wrangler deploy --dry-run\`).
`;

const outcomeLabel: Record<DeployStep["outcome"], string> = {
	done: "done     ",
	unchanged: "unchanged",
	"would run": "would run",
	skipped: "skipped  ",
};

const printStep =
	(io: CliIo) =>
	({ step, outcome, detail }: DeployStep) =>
		io.stdout(`  ${outcomeLabel[outcome]}  ${step}${detail === "" ? "" : ` (${detail})`}\n`);

export const deployCommand = async (args: string[], io: CliIo) => {
	const { values, positionals } = parseCommandArgs("deploy", args, {
		env: { type: "string" },
		plan: { type: "boolean" },
		confirm: { type: "string" },
		help: { type: "boolean", short: "h" },
	} as const);
	if (values.help === true) {
		io.stdout(deployHelp);
		return 0;
	}
	const usageError = (message: string) => new CliError(message, { usage: true, hint: `Usage: ${deployUsage}` });
	if (positionals.length > 0) throw usageError(`Unexpected arguments: ${positionals.join(" ")}`);
	if (values.env === undefined) throw usageError("deploy needs --env");
	const plan = values.plan === true;
	if (plan && values.confirm !== undefined) throw usageError("--plan and --confirm cannot be combined");
	const project = loadProjectConfig(io.cwd);
	const environment = resolveEnvironment(project, values.env);
	if (!environment.remote) {
		throw new CliError(`Environment "${environment.name}" is local and is never deployed`, {
			hint: "Run it with `takebase dev`.",
		});
	}
	if (!plan && values.confirm !== environment.name) {
		throw usageError(`Deploying "${environment.name}" changes remote resources; repeat --confirm ${environment.name}`);
	}
	io.stdout(
		`${plan ? "Plan for deploying" : "Deploying"} "${environment.name}"${plan ? " (nothing will change)" : ""}\n`,
	);
	const steps = await deployEnvironment(defaultRemoteDeps, project, environment, { plan, report: printStep(io) });
	if (plan) {
		const changes = steps.filter(({ outcome }) => outcome === "would run").length;
		io.stdout(`${changes} step(s) would run; nothing was changed.\n`);
	} else {
		io.stdout(`Deployed "${environment.name}".\n`);
	}
	return 0;
};

export const buildCommand = (args: string[], io: CliIo) => {
	const { values, positionals } = parseCommandArgs("build", args, {
		env: { type: "string" },
		help: { type: "boolean", short: "h" },
	} as const);
	if (values.help === true) {
		io.stdout(buildHelp);
		return 0;
	}
	if (positionals.length > 0) {
		throw new CliError(`Unexpected arguments: ${positionals.join(" ")}`, { usage: true, hint: `Usage: ${buildUsage}` });
	}
	const project = loadProjectConfig(io.cwd);
	const environment = resolveEnvironment(project, values.env);
	io.stdout(`Building "${environment.name}" (nothing is uploaded)\n`);
	buildEnvironment(defaultRemoteDeps, project, environment, printStep(io));
	io.stdout("Built.\n");
	return 0;
};
