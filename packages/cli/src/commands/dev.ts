import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { workerEnvironment } from "../services/environment.ts";
import { localKeyFile } from "../services/key-installation.ts";
import { applyMigrations } from "../services/migration-service.ts";
import { provisionTenant } from "../services/provisioning.ts";
import { localTenantProvider, tenantPlan } from "../services/tenant-providers.ts";
import { resolveTarget } from "../worker-target.ts";

// `takebase dev`: the whole local stack. It runs itself inside
// `firebase emulators:exec` (Auth and RTDB emulators of the environment's
// demo-* project), applies global migrations, provisions every declared tenant
// with the local provider, runs an optional seed command, then serves the
// global Worker, each tenant Worker and the app until interrupted.

const usage = "takebase dev [--env <name>] [--fresh] [--seed <command>]\n       takebase dev --stop [--env <name>]";

const help = `Run the local stack: emulators, the global Worker, every tenant Worker and the app.

Usage: ${usage}

Options:
  --env <name>      Local environment from takebase.jsonc (default: local)
  --fresh           Start every tenant's local D1 empty (removes .wrangler/state-<tenant>)
  --seed <command>  Shell command run after provisioning, before the Workers start
  --stop            Stop a running stack: every process listening on its ports
  -h, --help        Show this help

Only emulators and local D1 are used; nothing reaches Firebase or Cloudflare.
Press Ctrl-C to stop every process. If anything keeps a port afterwards (the
emulators and each wrangler run in their own process groups), run
\`takebase dev --stop\` from another terminal.
`;

const options = {
	env: { type: "string" },
	fresh: { type: "boolean" },
	seed: { type: "string" },
	stop: { type: "boolean" },
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
	const adminOrigin = project.workers.admin === undefined ? undefined : `http://localhost:${environment.adminPort}`;
	// The browser apps the Workers answer: the app, and the admin when there is one.
	const browserOrigins = [appOrigin, ...(adminOrigin === undefined ? [] : [adminOrigin])].join(",");
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
	// The tenants' data keys for this run (mkdtemp: mode 700), removed on stop.
	const keysDir = mkdtempSync(join(tmpdir(), "takebase-dev-keys-"));
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
				CORS_ORIGINS: browserOrigins,
			}),
		);
		await ready(`http://localhost:${environment.globalPort}/health`);
		environment.tenants.forEach((tenant, index) => {
			// Each tenant Worker gets only its own data key, from a mode-600 file
			// that is removed when the stack stops: never a --var on a command line.
			const version = Number(workerEnvironment(project.workers.tenant, tenant.env)?.vars.DATA_KEY_VERSION ?? "");
			const keyFile = Number.isSafeInteger(version) ? localKeyFile(environment, tenant.id, version, keysDir) : null;
			run(`tenant ${tenant.id}`, project.workers.tenant, "wrangler", [
				...wranglerDev(tenant.port ?? 0, 9231 + index, tenant.env, {
					CORS_ORIGINS: browserOrigins,
					FIREBASE_DISPATCHER_EMAIL: dispatcherEmail(environment, tenant.id),
					FIREBASE_DISPATCHER_PASSWORD: environment.dispatcherPassword ?? "",
				}),
				...(keyFile === null ? [] : ["--env-file", keyFile]),
				"--persist-to",
				tenantState(tenant.id),
			]);
		});
		await Promise.all(environment.tenants.map(({ port }) => ready(`http://localhost:${port}/health`)));
		// The apps start last, so once they answer the whole stack is up.
		run("app", project.workers.app, "vite", ["dev", "--port", String(environment.appPort), "--strictPort"]);
		if (project.workers.admin !== undefined) {
			run("admin", project.workers.admin, "vite", ["dev", "--port", String(environment.adminPort), "--strictPort"]);
		}
		await Promise.all([appOrigin, ...(adminOrigin === undefined ? [] : [adminOrigin])].map((origin) => ready(origin)));
		io.stdout(
			`\nTakebase local stack is up (emulators only; nothing reaches Firebase or Cloudflare).\n` +
				`  App:      ${appOrigin}\n` +
				(adminOrigin === undefined ? "" : `  Admin:    ${adminOrigin}\n`) +
				`  Global:   http://localhost:${environment.globalPort}\n` +
				`  Tenants:  ${environment.tenants.map(({ id, port }) => `${id} http://localhost:${port}`).join(", ")}\n` +
				"Press Ctrl-C to stop.\n",
		);
	} catch (error) {
		io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
		stop(1);
	}
	const code = await done;
	rmSync(keysDir, { recursive: true, force: true });
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);
	return code;
};

// Every port the stack listens on: the Workers, the app, the Workers'
// inspectors and the Firebase emulators (firebase.json, plus the hub and
// logging defaults).
const stackPorts = (project: ProjectConfig, environment: EnvironmentConfig) => {
	const ports = new Set<number>([4400, 4500]);
	const apps = [environment.globalPort, environment.appPort, environment.adminPort];
	for (const port of [...apps, ...environment.tenants.map((t) => t.port)]) {
		if (port !== undefined) ports.add(port);
	}
	for (let index = 0; index <= environment.tenants.length; index++) ports.add(9230 + index);
	const firebaseFile = join(project.root, "firebase.json");
	if (existsSync(firebaseFile)) {
		const emulators = (JSON.parse(readFileSync(firebaseFile, "utf8")) as { emulators?: Record<string, unknown> })
			.emulators;
		for (const value of Object.values(emulators ?? {})) {
			const port = (value as { port?: unknown } | null)?.port;
			if (typeof port === "number") ports.add(port);
		}
	}
	return [...ports].sort((a, b) => a - b);
};

const listeners = (port: number) =>
	(spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).stdout ?? "")
		.split("\n")
		.map(Number)
		.filter((pid) => Number.isInteger(pid) && pid > 1);

const describeProcess = (pid: number) => {
	const out = spawnSync("ps", ["-o", "pgid=,comm=", "-p", String(pid)], { encoding: "utf8" }).stdout?.trim() ?? "";
	const [pgid, ...command] = out.split(/\s+/);
	return { pgid: Number(pgid), command: command.join(" ").split("/").at(-1) ?? "" };
};

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// Stops whatever holds the stack's ports, with its whole process group (wrangler
// with its workerd, the emulators with their exec wrapper). Never this
// process's own group. SIGTERM first, SIGKILL for anything still there.
const stopStack = async (io: CliIo, project: ProjectConfig, environment: EnvironmentConfig) => {
	const ownGroup = describeProcess(process.pid).pgid;
	const groups = new Map<number, Set<string>>();
	const pids = new Set<number>();
	for (const port of stackPorts(project, environment)) {
		for (const pid of listeners(port)) {
			const { pgid, command } = describeProcess(pid);
			pids.add(pid);
			if (!Number.isInteger(pgid) || pgid <= 1 || pgid === ownGroup) continue;
			groups.set(pgid, (groups.get(pgid) ?? new Set()).add(`${command} :${port}`));
		}
	}
	if (pids.size === 0) {
		io.stdout("No process is listening on the local stack's ports.\n");
		return 0;
	}
	const signal = (sig: NodeJS.Signals) => {
		for (const pgid of groups.keys()) {
			try {
				process.kill(-pgid, sig);
			} catch {}
		}
		for (const pid of pids) {
			try {
				if (alive(pid)) process.kill(pid, sig);
			} catch {}
		}
	};
	for (const [pgid, held] of groups) io.stdout(`Stopping process group ${pgid} (${[...held].join(", ")})\n`);
	signal("SIGTERM");
	for (let attempt = 0; attempt < 20 && [...pids].some(alive); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	if ([...pids].some(alive)) signal("SIGKILL");
	await new Promise((resolve) => setTimeout(resolve, 250));
	const left = stackPorts(project, environment).filter((port) => listeners(port).length > 0);
	if (left.length > 0) {
		throw new CliError(`Ports still in use: ${left.join(", ")}`, {
			hint: "Another user's process, or one this CLI may not signal, holds them; check with `lsof -nP -iTCP -sTCP:LISTEN`.",
		});
	}
	io.stdout("The local stack is stopped; its ports are free.\n");
	return 0;
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
	if (values.stop === true) {
		if (values.fresh === true || values.seed !== undefined) {
			throw new CliError("--stop takes no --fresh or --seed", { usage: true, hint: `Usage: ${usage}` });
		}
		return stopStack(io, project, environment);
	}
	if (!insideEmulators()) return underEmulators(project, environment, args);
	return stack(io, project, environment, values.fresh === true, values.seed);
};
