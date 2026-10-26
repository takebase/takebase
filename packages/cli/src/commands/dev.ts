import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommandArgs } from "../args.ts";
import { CliError, type CliIo } from "../errors.ts";
import {
	dispatcherEmail,
	type EnvironmentConfig,
	loadProjectConfig,
	type ProjectConfig,
	resolveEnvironment,
} from "../project-config.ts";
import { applyMigrations } from "../services/migration-service.ts";
import { provisionTenant } from "../services/provisioning.ts";
import { localTenantProvider, tenantPlan } from "../services/tenant-providers.ts";
import { resolveTarget } from "../worker-target.ts";

// `takebase dev`: the whole local stack. It runs itself inside
// `firebase emulators:exec` (Auth and RTDB emulators of the environment's
// demo-* project), applies global migrations, provisions every declared tenant
// with the local provider, runs an optional seed command, then serves the
// global Worker, each tenant Worker and the app until interrupted.

const usage = "takebase dev [--env <name>] [--fresh] [--seed <command>]";

const help = `Run the local stack: emulators, the global Worker, every tenant Worker and the app.

Usage: ${usage}

Options:
  --env <name>      Local environment from takebase.jsonc (default: local)
  --fresh           Start every tenant's local D1 empty (removes .wrangler/state-<tenant>)
  --seed <command>  Shell command run after provisioning, before the Workers start
  -h, --help        Show this help

Only emulators and local D1 are used; nothing reaches Firebase or Cloudflare.
Press Ctrl-C to stop every process.
`;

const options = {
	env: { type: "string" },
	fresh: { type: "boolean" },
	seed: { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const insideEmulators = () =>
	process.env.FIREBASE_AUTH_EMULATOR_HOST !== undefined && process.env.FIREBASE_DATABASE_EMULATOR_HOST !== undefined;

// Waits for a child to exit and forwards Ctrl-C and SIGTERM to it.
const supervise = (child: ChildProcess) =>
	new Promise<number>((resolve) => {
		const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
		const onInt = forward("SIGINT");
		const onTerm = forward("SIGTERM");
		process.on("SIGINT", onInt);
		process.on("SIGTERM", onTerm);
		child.on("exit", (code, signal) => {
			process.off("SIGINT", onInt);
			process.off("SIGTERM", onTerm);
			resolve(code ?? (signal ? 1 : 0));
		});
	});

const underEmulators = (project: ProjectConfig, environment: EnvironmentConfig, args: string[]) => {
	const bin = fileURLToPath(new URL("../bin.ts", import.meta.url));
	const command = [process.execPath, bin, "dev", ...args].map(shellQuote).join(" ");
	const child = spawn(
		"firebase",
		["emulators:exec", "--only", "auth,database", "--project", environment.firebaseProject, command],
		{ cwd: project.root, stdio: "inherit" },
	);
	return supervise(child);
};

const ready = async (url: string) => {
	for (let attempt = 0; attempt < 120; attempt++) {
		try {
			if ((await fetch(url)).ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new CliError(`${url} did not start`);
};

const stack = async (
	io: CliIo,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	fresh: boolean,
	seed?: string,
) => {
	const tenantState = (id: string) => join(project.workers.tenant, ".wrangler", `state-${id}`);
	if (fresh) for (const { id } of environment.tenants) rmSync(tenantState(id), { recursive: true, force: true });

	const global = applyMigrations(
		resolveTarget(project.root, { worker: project.workers.global, env: environment.globalEnv }),
	);
	io.stdout(
		`global migrations: ${global.applied.length === 0 ? "up to date" : `applied ${global.applied.join(", ")}`}\n`,
	);
	for (const tenant of environment.tenants) {
		const results = await provisionTenant(
			localTenantProvider(project, environment, tenant),
			await tenantPlan(project, environment, tenant),
		);
		const created = results.filter(({ outcome }) => outcome === "created").map(({ step }) => step);
		const status = results.at(-1)?.detail;
		io.stdout(
			`tenant ${tenant.id}: ${status === "disabled" ? "provisioned but disabled" : "ready"}${created.length === 0 ? "" : ` (created ${created.join(", ")})`}\n`,
		);
	}
	if (seed !== undefined) {
		const result = spawnSync("sh", ["-c", seed], { cwd: project.root, stdio: "inherit" });
		if (result.status !== 0) throw new CliError(`The seed command exited with ${result.status ?? result.signal}`);
	}

	const appOrigin = `http://localhost:${environment.appPort}`;
	const children: ChildProcess[] = [];
	let stopping = false;
	let stopped: (code: number) => void = () => {};
	const done = new Promise<number>((resolve) => {
		stopped = resolve;
	});
	const stop = (code: number) => {
		if (stopping) return;
		stopping = true;
		// Each child leads its own process group, so wrangler's workerd and vite's
		// workers stop with it instead of keeping the ports.
		for (const child of children) {
			try {
				if (child.pid) process.kill(-child.pid, "SIGTERM");
			} catch {}
		}
		stopped(code);
	};
	const run = (name: string, dir: string, tool: "wrangler" | "vite", args: string[]) => {
		const child = spawn(join(dir, "node_modules", ".bin", tool), args, {
			cwd: dir,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const prefix = (chunk: Buffer) =>
			chunk
				.toString()
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => `[${name}] ${line}\n`)
				.join("");
		child.stdout?.on("data", (chunk: Buffer) => io.stdout(prefix(chunk)));
		child.stderr?.on("data", (chunk: Buffer) => io.stderr(prefix(chunk)));
		child.on("exit", (code) => {
			if (stopping) return;
			io.stderr(`[${name}] exited with ${code}; stopping the stack\n`);
			stop(1);
		});
		children.push(child);
	};
	const onSignal = () => stop(0);
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	const wranglerDev = (port: number, inspector: number, env: string | undefined, vars: Record<string, string>) => [
		"dev",
		"--port",
		String(port),
		"--inspector-port",
		String(inspector),
		...(env === undefined ? [] : ["--env", env]),
		...Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`]),
	];

	try {
		// Emulator trust is a local-only variable, never in wrangler.jsonc.
		run(
			"global",
			project.workers.global,
			"wrangler",
			wranglerDev(environment.globalPort ?? 0, 9230, environment.globalEnv, {
				TAKEBASE_AUTH_EMULATOR: "local-only",
				CORS_ORIGINS: appOrigin,
			}),
		);
		await ready(`http://localhost:${environment.globalPort}/health`);
		environment.tenants.forEach((tenant, index) => {
			run(`tenant ${tenant.id}`, project.workers.tenant, "wrangler", [
				...wranglerDev(tenant.port ?? 0, 9231 + index, tenant.env, {
					CORS_ORIGINS: appOrigin,
					FIREBASE_DISPATCHER_EMAIL: dispatcherEmail(environment, tenant.id),
					FIREBASE_DISPATCHER_PASSWORD: environment.dispatcherPassword ?? "",
				}),
				"--persist-to",
				tenantState(tenant.id),
			]);
		});
		await Promise.all(environment.tenants.map(({ port }) => ready(`http://localhost:${port}/health`)));
		// The app starts last, so once it answers the whole stack is up.
		run("app", project.workers.app, "vite", ["dev", "--port", String(environment.appPort), "--strictPort"]);
		await ready(appOrigin);
		io.stdout(
			`\nTakebase local stack is up (emulators only; nothing reaches Firebase or Cloudflare).\n` +
				`  App:      ${appOrigin}\n` +
				`  Global:   http://localhost:${environment.globalPort}\n` +
				`  Tenants:  ${environment.tenants.map(({ id, port }) => `${id} http://localhost:${port}`).join(", ")}\n` +
				"Press Ctrl-C to stop.\n",
		);
	} catch (error) {
		io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
		stop(1);
	}
	const code = await done;
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);
	return code;
};

export const devCommand = async (args: string[], io: CliIo) => {
	const { values, positionals } = parseCommandArgs("dev", args, options);
	if (values.help === true) {
		io.stdout(help);
		return 0;
	}
	if (positionals.length > 0) {
		throw new CliError(`Unexpected arguments: ${positionals.join(" ")}`, { usage: true, hint: `Usage: ${usage}` });
	}
	const project = loadProjectConfig(io.cwd);
	const environment = resolveEnvironment(project, values.env);
	if (environment.remote) {
		throw new CliError(`Environment "${environment.name}" is remote; \`takebase dev\` runs local environments only`, {
			usage: true,
			hint: `Deploy it with \`takebase deploy --env ${environment.name}\`.`,
		});
	}
	if (!insideEmulators()) return underEmulators(project, environment, args);
	return stack(io, project, environment, values.fresh === true, values.seed);
};
