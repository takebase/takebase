import { parseCommandArgs } from "../args.ts";
import { CliError, type CliIo } from "../errors.ts";
import { loadProjectConfig, resolveEnvironment } from "../project-config.ts";
import { appEndpoint, type Endpoint, globalEndpoint, tenantEndpoint } from "../services/endpoints.ts";

// Liveness (`/health`) and dependency readiness (`/health/ready`) of every
// Worker in one environment, plus whether the app answers. Read-only: plain
// GETs without credentials, so the answers hold no private detail.

const usage = "takebase health [--env <name>]";

const help = `Check that the Workers of one environment are live and ready.

Usage: ${usage}

Options:
  --env <name>  Environment from takebase.jsonc (default: local)
  -h, --help    Show this help

For the global Worker and each tenant Worker, checks /health (the Worker runs)
and /health/ready (its D1 database, the global RPC binding and realtime
settings). Also checks that the app answers. Exits 1 when anything fails.
Locally, start the stack with \`takebase dev\` first.
`;

const options = { env: { type: "string" }, help: { type: "boolean", short: "h" } } as const;

// The `/health/ready` answer (Readiness in @takebase/contracts).
type Readiness = { status: "ok" | "degraded" | "error"; checks: Record<string, string> };

type Fetched = { status: number; body: unknown } | { status: 0; error: string };

const get = async (url: string): Promise<Fetched> => {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
		const text = await response.text();
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			body = undefined;
		}
		return { status: response.status, body };
	} catch (error) {
		return { status: 0, error: error instanceof Error && error.name === "TimeoutError" ? "timed out" : "unreachable" };
	}
};

const isReadiness = (body: unknown): body is Readiness =>
	typeof body === "object" &&
	body !== null &&
	typeof (body as Readiness).status === "string" &&
	typeof (body as Readiness).checks === "object";

export const healthCommand = async (args: string[], io: CliIo) => {
	const { values, positionals } = parseCommandArgs("health", args, options);
	if (values.help === true) {
		io.stdout(help);
		return 0;
	}
	if (positionals.length > 0) {
		throw new CliError(`Unexpected arguments: ${positionals.join(" ")}`, { usage: true, hint: `Usage: ${usage}` });
	}
	const project = loadProjectConfig(io.cwd);
	const environment = resolveEnvironment(project, values.env);
	const workers: Endpoint[] = [
		globalEndpoint(project, environment),
		...environment.tenants.map((tenant) => tenantEndpoint(project, environment, tenant.id)),
	];
	let failed = 0;
	const line = (status: "ok" | "warn" | "fail", label: string, detail: string) => {
		if (status === "fail") failed++;
		io.stdout(`${status === "ok" ? "ok  " : status === "warn" ? "warn" : "FAIL"} ${label}: ${detail}\n`);
	};

	io.stdout(`Health of environment "${environment.name}" (${environment.remote ? "remote" : "local"})\n`);
	for (const { label, url } of workers) {
		const live = await get(`${url}/health`);
		if (live.status !== 200) {
			line("fail", `${label} live`, "error" in live ? `${live.error} (${url})` : `HTTP ${live.status}`);
			continue;
		}
		line("ok", `${label} live`, url);
		const ready = await get(`${url}/health/ready`);
		if (!("body" in ready) || !isReadiness(ready.body)) {
			line("fail", `${label} ready`, "error" in ready ? ready.error : `HTTP ${ready.status}, no readiness answer`);
			continue;
		}
		const checks = Object.entries(ready.body.checks)
			.map(([name, state]) => `${name} ${state}`)
			.join(", ");
		line(
			ready.body.status === "ok" ? "ok" : ready.body.status === "degraded" ? "warn" : "fail",
			`${label} ready`,
			checks,
		);
	}
	const app = appEndpoint(project, environment);
	const answer = await get(app.url);
	if (answer.status > 0 && answer.status < 400) line("ok", "app", `HTTP ${answer.status} ${app.url}`);
	else line("fail", "app", "error" in answer ? `${answer.error} (${app.url})` : `HTTP ${answer.status}`);

	io.stdout(failed === 0 ? "\nAll Workers are live and ready.\n" : `\n${failed} check(s) failed.\n`);
	return failed === 0 ? 0 : 1;
};
