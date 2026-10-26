import { execFileSync } from "node:child_process";
import { appUrl, databaseUrl, globalUrl, password, signIn, tenants, tenantUrl, users } from "./staging.ts";
import { journey, resetSignals, seedStatements, signInAll, uidsOf } from "./staging-journey.ts";

// Staging fixtures and wiring checks (SEGU-218), run from the repository root.
// Migrations and deploys belong to the CLI since SEGU-219:
//
//   pnpm staging:deploy:plan           takebase deploy --env staging --plan (read-only)
//   pnpm staging:deploy                takebase deploy --env staging --confirm staging
//   pnpm staging:check                 takebase doctor --env staging, then the wiring below
//   pnpm staging:seed                  tenants and memberships in the staging global D1
//   pnpm staging:journey               the R-4-4-01 journey against the deployed Workers

const root = new URL("../", import.meta.url).pathname;
const dir = (name: "global" | "tenant" | "sveltekit") =>
	name === "sveltekit" ? `${root}examples/sveltekit` : `${root}examples/workers/${name}`;

const exec = (cwd: string, command: string, args: string[], env: Record<string, string> = {}) =>
	execFileSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...env } });

const wrangler = (cwd: string, args: string[]) => exec(cwd, "pnpm", ["exec", "wrangler", ...args]);

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

const check = async () => {
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
	console.log(failures === 0 ? "All wiring checks passed." : `${failures} check(s) failed.`);
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

const [command] = process.argv.slice(2);
if (command === "seed") await seed();
else if (command === "journey") await runJourney();
else if (command === "check") await check();
else {
	console.error("usage: node ops/staging-cloudflare.ts check | seed | journey");
	process.exitCode = 2;
}
