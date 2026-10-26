import { type ChildProcess, spawn } from "node:child_process";
import {
	appOrigin,
	dispatcherEmail,
	globalPort,
	password,
	seed,
	type TenantId,
	tenantState,
	tenants,
	tenantUrl,
	users,
	workerDir,
} from "./tenants.ts";

// The local milestone stack, started by `pnpm dev:stack` inside
// `firebase emulators:exec` (Auth and RTDB emulators, demo-takebase only):
// seeds the fixture, then runs the global Worker, both tenant Workers and the
// SvelteKit example until interrupted. The tenant Workers reach the global
// Worker's MembershipEntrypoint through wrangler's local dev registry.

if (!process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
	throw new Error("Run this through `pnpm dev:stack`, which starts the Firebase emulators");
}

const children: ChildProcess[] = [];
let stopping = false;

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
	process.exit(code);
};

const run = (name: string, cwd: string, command: string, args: string[]) => {
	const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
	const prefix = (chunk: Buffer) =>
		chunk
			.toString()
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => `[${name}] ${line}\n`)
			.join("");
	child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(prefix(chunk)));
	child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(prefix(chunk)));
	child.on("exit", (code) => {
		if (stopping) return;
		console.error(`[${name}] exited with ${code}; stopping the stack`);
		stop(1);
	});
	children.push(child);
};

const ready = async (url: string) => {
	for (let attempt = 0; attempt < 120; attempt++) {
		try {
			if ((await fetch(url)).ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`${url} did not start`);
};

const wranglerDev = (port: number, inspector: number, vars: Record<string, string>, env?: TenantId) => [
	"exec",
	"wrangler",
	"dev",
	"--port",
	String(port),
	"--inspector-port",
	String(inspector),
	...(env ? ["--env", env, "--persist-to", tenantState(env)] : []),
	...Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`]),
];

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

try {
	await seed();

	run(
		"global",
		workerDir("global"),
		"pnpm",
		wranglerDev(globalPort, 9230, { TAKEBASE_AUTH_EMULATOR: "local-only", CORS_ORIGINS: appOrigin }),
	);
	await ready(`http://localhost:${globalPort}/health`);
	tenants.forEach(({ id, port }, index) => {
		run(
			id,
			workerDir("tenant"),
			"pnpm",
			wranglerDev(
				port,
				9231 + index,
				{
					CORS_ORIGINS: appOrigin,
					FIREBASE_DISPATCHER_EMAIL: dispatcherEmail(id),
					FIREBASE_DISPATCHER_PASSWORD: password,
				},
				id,
			),
		);
	});
	// The app starts last, so once it answers the whole stack is up.
	await Promise.all(tenants.map(({ port }) => ready(`${tenantUrl(port)}/health`)));
	run("app", new URL("../../examples/sveltekit", import.meta.url).pathname, "pnpm", [
		"exec",
		"vite",
		"dev",
		"--port",
		"5173",
		"--strictPort",
	]);
	await ready(appOrigin);
} catch (error) {
	console.error(error);
	stop(1);
}

console.log(`
Takebase local stack is up (emulators only; nothing reaches Firebase or Cloudflare).
  App:      ${appOrigin}
  Users:    ${Object.values(users)
		.map(({ email }) => email)
		.join(", ")} (password: ${password})
  Tenants:  ${tenants.map(({ id, port }) => `${id} ${tenantUrl(port)}`).join(", ")}
Press Ctrl-C to stop.`);
