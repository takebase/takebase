import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
	apiKey,
	appUrl,
	databaseUrl,
	dispatcherEmail,
	globalUrl,
	opsPath,
	password,
	projectId,
	signIn,
	type Tenant,
	tenants,
	tenantUrl,
	users,
} from "./staging.ts";
import { journey, resetSignals, seedStatements, signInAll, uidsOf } from "./staging-journey.ts";

// SEGU-218 Section D: Cloudflare staging in the shared account, takebase-staging-*
// only. One step at a time, from the repository root:
//
//   pnpm staging:migrate               remote D1 migrations, then the remote list
//   pnpm staging:deploy global         the global Worker
//   pnpm staging:deploy tenant-a       a tenant Worker, its secrets uploaded with it
//   pnpm staging:deploy app            the SvelteKit app, built with staging settings
//   pnpm staging:check                 health, schema and wiring of what is deployed
//   pnpm staging:seed                  tenants and memberships in the staging global D1
//   pnpm staging:journey               the R-4-4-01 journey against the deployed Workers
//
// Secrets go up with each deploy from an untracked ops/.staging/*.secrets.json
// (mode 600); nothing secret is passed on a command line or kept in the repo.

const root = new URL("../", import.meta.url).pathname;
const dir = (name: "global" | "tenant" | "sveltekit") =>
	name === "sveltekit" ? `${root}examples/sveltekit` : `${root}examples/workers/${name}`;

const exec = (cwd: string, command: string, args: string[], env: Record<string, string> = {}) =>
	execFileSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...env } });

const wrangler = (cwd: string, args: string[]) => exec(cwd, "pnpm", ["exec", "wrangler", ...args]);

const tenantById = (id: string) => {
	const tenant = tenants.find((candidate) => candidate.id === id);
	if (!tenant) throw new Error(`Unknown tenant ${id}`);
	return tenant;
};

const migrate = () => {
	wrangler(dir("global"), ["d1", "migrations", "apply", "DB", "--remote", "--env", "staging"]);
	for (const tenant of tenants) {
		wrangler(dir("tenant"), ["d1", "migrations", "apply", "DB", "--remote", "--env", `staging-${tenant.id}`]);
	}
};

const secretsFile = (tenant: Tenant) => {
	mkdirSync(opsPath(".staging"), { recursive: true });
	const path = opsPath(`.staging/${tenant.id}.secrets.json`);
	const secrets = {
		FIREBASE_API_KEY: apiKey(),
		FIREBASE_DISPATCHER_EMAIL: dispatcherEmail(tenant),
		FIREBASE_DISPATCHER_PASSWORD: password(`dispatcher-${tenant.id}`),
	};
	writeFileSync(path, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
	return path;
};

const deploy = (target: string) => {
	if (target === "global") return wrangler(dir("global"), ["deploy", "--env", "staging"]);
	if (target === "app") {
		const settings = {
			VITE_TAKEBASE_GLOBAL_URL: globalUrl(),
			VITE_FIREBASE_API_KEY: apiKey(),
			VITE_FIREBASE_PROJECT_ID: projectId,
		};
		exec(dir("sveltekit"), "pnpm", ["exec", "vite", "build"], settings);
		return wrangler(dir("sveltekit"), ["deploy", "--env", "staging"]);
	}
	const tenant = tenantById(target);
	return wrangler(dir("tenant"), ["deploy", "--env", `staging-${tenant.id}`, "--secrets-file", secretsFile(tenant)]);
};

let failures = 0;
const expect = (label: string, ok: boolean, detail: string) => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}`);
};

const get = async (url: string, init: RequestInit = {}) => {
	try {
		const response = await fetch(url, init);
		return { status: response.status, body: await response.text() };
	} catch (error) {
		return { status: 0, body: String(error) };
	}
};

const pending = (cwd: string, env: string) => {
	const output = execFileSync(
		"pnpm",
		["exec", "wrangler", "d1", "migrations", "list", "DB", "--remote", "--env", env],
		{
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	return output.includes("No migrations to apply") ? "none pending" : output.split("\n").slice(-12).join("\n");
};

const check = async () => {
	console.log("-- schema (wrangler d1 migrations list --remote)");
	const globalSchema = pending(dir("global"), "staging");
	expect("global D1 migrations", globalSchema === "none pending", globalSchema);
	for (const tenant of tenants) {
		const schema = pending(dir("tenant"), `staging-${tenant.id}`);
		expect(`${tenant.id} D1 migrations`, schema === "none pending", schema);
	}

	console.log("-- deployed Workers");
	const global = await get(`${globalUrl()}/health`);
	expect(
		"global /health",
		global.status === 200 && global.body.includes('"database":"ok"'),
		`${global.status} ${global.body}`,
	);
	const alice = await signIn(users.alice.email, password("alice"));
	for (const tenant of tenants) {
		const health = await get(`${tenantUrl(tenant)}/health`);
		expect(
			`${tenant.id} /health`,
			health.status === 200 &&
				health.body.includes(`"tenantId":"${tenant.id}"`) &&
				health.body.includes('"database":"ok"'),
			`${health.status} ${health.body}`,
		);
		// A real token reaches the global Worker over the service binding: 200 (a
		// member) or 403 (not seeded yet) are answers; 503 means no answer.
		const membership = await get(`${tenantUrl(tenant)}/api/collections/policies/records?perPage=1`, {
			headers: { authorization: `Bearer ${alice.token}` },
		});
		expect(
			`${tenant.id} reaches the global Worker's membership RPC`,
			membership.status === 403 || membership.status === 200,
			membership.status === 200 ? "200 (alice is a member)" : `${membership.status} ${membership.body.slice(0, 120)}`,
		);
		console.log(`     ${tenant.id} realtime: ${databaseUrl(tenant)}`);
	}
	const app = await get(appUrl());
	expect("app page", app.status === 200 && app.body.includes("__sveltekit"), String(app.status));
	console.log(failures === 0 ? "All Section D checks passed." : `${failures} check(s) failed.`);
	process.exitCode = failures === 0 ? 0 : 1;
};

// Writes the staging global D1 (tenants upserted, memberships rewritten) and
// clears the tenants' RTDB signals. Those databases are shared with
// `pnpm staging:local:check`, whose local tenant D1 restarts its revisions on
// every run; seed again after a local check, before the deployed journey.
const seed = async () => {
	const statements = seedStatements(uidsOf(await signInAll()), tenantUrl);
	wrangler(dir("global"), ["d1", "execute", "DB", "--remote", "--env", "staging", "--command", statements]);
	for (const tenant of tenants)
		console.log(`${tenant.id} signals cleared: ${(await resetSignals(tenant)).join(", ") || "none"}`);
};

const runJourney = async () => {
	const failures = await journey({ globalUrl: globalUrl(), tenantUrl }, await signInAll());
	console.log(failures === 0 ? "All Section E checks passed." : `${failures} check(s) failed.`);
	process.exitCode = failures === 0 ? 0 : 1;
};

const [command, target] = process.argv.slice(2);
if (command === "migrate") migrate();
else if (command === "seed") await seed();
else if (command === "journey") await runJourney();
else if (command === "deploy" && target) deploy(target);
else if (command === "check") await check();
else {
	console.error("usage: node ops/staging-cloudflare.ts migrate | deploy <target> | check | seed | journey");
	process.exitCode = 2;
}
