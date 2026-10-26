import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
	apiKey,
	databaseUrl,
	dispatcherEmail,
	opsPath,
	password,
	projectId,
	type Tenant,
	tenants,
	type UserName,
} from "./staging.ts";
import { journey, resetSignals, seedStatements, signInAll, uidsOf } from "./staging-journey.ts";

// SEGU-218 Section C: the real Workers, run locally with `wrangler dev`, against
// the real Firebase project. Proves that the global Worker verifies real
// Firebase ID tokens (Google signing keys, no emulator trust) and that the
// tenant Worker's adapter writes to the real tenant databases, before anything
// is deployed to Cloudflare.
//
//   pnpm staging:local:check          start, check, stop
//   pnpm staging:local:check --keep   start, check, keep running until Ctrl-C
//
// D1 stays local, in .wrangler/state-staging* directories of its own; tenant D1
// starts empty on every run, and so do the tenants' RTDB signals. Overrides go through untracked --env-file files in
// ops/.staging/, so no password appears on a command line. Do not run this next
// to `pnpm dev:stack`: both register the same Worker names locally.

const root = new URL("../", import.meta.url).pathname;
const workerDir = (name: "global" | "tenant") => `${root}examples/workers/${name}`;
const globalPort = 8790;
const tenantPort = (tenant: Tenant) => 8791 + tenants.indexOf(tenant);
const tenantUrl = (tenant: Tenant) => `http://localhost:${tenantPort(tenant)}`;
const globalUrl = `http://localhost:${globalPort}`;
const globalState = ".wrangler/state-staging";
const tenantState = (tenant: Tenant) => `.wrangler/state-staging-${tenant.id}`;

const children: ChildProcess[] = [];
let stopping = false;

const stop = (code: number) => {
	if (stopping) return;
	stopping = true;
	for (const child of children) {
		try {
			if (child.pid) process.kill(-child.pid, "SIGTERM");
		} catch {}
	}
	setTimeout(() => process.exit(code), 1_000);
};

const run = (name: string, cwd: string, args: string[]) => {
	const child = spawn("pnpm", args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
	const prefix = (chunk: Buffer) =>
		chunk
			.toString()
			.split("\n")
			.filter((line) => line.trim() !== "" && !line.includes("Proxy environment variables"))
			.map((line) => `[${name}] ${line}\n`)
			.join("");
	child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(prefix(chunk)));
	child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(prefix(chunk)));
	child.on("exit", (code) => {
		if (stopping) return;
		console.error(`[${name}] exited with ${code}; stopping`);
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

const wrangler = (cwd: string, args: string[]) =>
	execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd, stdio: ["ignore", "ignore", "inherit"] });

const envFile = (name: string, values: Record<string, string>) => {
	const path = opsPath(`.staging/${name}.env`);
	writeFileSync(
		path,
		`${Object.entries(values)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n")}\n`,
		{ mode: 0o600 },
	);
	return path;
};

const seed = (uids: Record<UserName, string>) => {
	wrangler(workerDir("global"), ["d1", "migrations", "apply", "DB", "--local", "--persist-to", globalState]);
	wrangler(workerDir("global"), [
		"d1",
		"execute",
		"DB",
		"--local",
		"--persist-to",
		globalState,
		"--command",
		seedStatements(uids, tenantUrl),
	]);
	for (const tenant of tenants) {
		rmSync(`${workerDir("tenant")}/${tenantState(tenant)}`, { recursive: true, force: true });
		wrangler(workerDir("tenant"), [
			"d1",
			"migrations",
			"apply",
			"DB",
			"--local",
			"--env",
			tenant.id,
			"--persist-to",
			tenantState(tenant),
		]);
	}
};

const start = () => {
	mkdirSync(opsPath(".staging"), { recursive: true });
	const globalEnv = envFile("global", { FIREBASE_PROJECT_ID: projectId });
	run("global", workerDir("global"), [
		"exec",
		"wrangler",
		"dev",
		"--port",
		String(globalPort),
		"--inspector-port",
		"9240",
		"--persist-to",
		globalState,
		"--env-file",
		globalEnv,
	]);
	return ready(`${globalUrl}/health`).then(async () => {
		tenants.forEach((tenant, index) => {
			const env = envFile(tenant.id, {
				FIREBASE_DATABASE_URL: databaseUrl(tenant),
				FIREBASE_API_KEY: apiKey(),
				FIREBASE_DISPATCHER_EMAIL: dispatcherEmail(tenant),
				FIREBASE_DISPATCHER_PASSWORD: password(`dispatcher-${tenant.id}`),
			});
			run(tenant.id, workerDir("tenant"), [
				"exec",
				"wrangler",
				"dev",
				"--port",
				String(tenantPort(tenant)),
				"--inspector-port",
				String(9241 + index),
				"--env",
				tenant.id,
				"--persist-to",
				tenantState(tenant),
				"--env-file",
				env,
			]);
		});
		await Promise.all(tenants.map((tenant) => ready(`${tenantUrl(tenant)}/health`)));
	});
};

let failures = 0;

process.on("SIGINT", () => stop(failures === 0 ? 0 : 1));
process.on("SIGTERM", () => stop(1));

try {
	const sessions = await signInAll();
	seed(uidsOf(sessions));
	// Tenant D1 was just recreated, so its signals start over too.
	for (const tenant of tenants) await resetSignals(tenant);
	await start();
	failures = await journey({ globalUrl, tenantUrl }, sessions);
	console.log(failures === 0 ? "All Section C checks passed." : `${failures} check(s) failed.`);
	if (process.argv.includes("--keep")) {
		console.log(
			`Running: global ${globalUrl}, ${tenants.map((tenant) => `${tenant.id} ${tenantUrl(tenant)}`).join(", ")}. Ctrl-C stops.`,
		);
	} else stop(failures === 0 ? 0 : 1);
} catch (error) {
	console.error(error);
	stop(1);
}
