import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { loadProjectConfig, resolveEnvironment } from "../packages/cli/src/project-config.ts";
import { readSecretsFile } from "../packages/cli/src/secrets-file.ts";
import { queryD1, workerEnvironment, workerUrl } from "../packages/cli/src/services/environment.ts";
import { databaseEmulator, namespace, signIn as signInLocally } from "../tests/fixtures/tenants.ts";
import { type BundleResult, measureBundle } from "./bundle.ts";
import { benchmarkCrud } from "./crud.ts";
import { type Sizes, type Stats, type Target, table } from "./lib.ts";
import { benchmarkQueries } from "./query.ts";
import { type DrainResult, outboxDrain, type SignalLatency, signalLatency } from "./realtime.ts";

// Repeatable measurements of tenant-a (SEGU-229). They only describe this code
// on this target; they are not performance budgets.
//
//   pnpm benchmark:local     against a running `pnpm dev:stack`; writes results/local.json
//   pnpm benchmark:quick     the same at a small size; writes nothing
//   pnpm staging:benchmark   takebase-staging-tenant-a, at most 200 Worker requests
//
// Records are numbered BENCH-*, and each run removes its own. Their outbox rows stay.
// Locally, the numbers measure workerd and SQLite on this machine, not Cloudflare,
// and the stack trusts unsigned emulator tokens. Against staging they include
// this machine's network path, and no fixture rows are added.

const envName = process.argv.includes("--env") ? (process.argv[process.argv.indexOf("--env") + 1] ?? "") : "local";
const quick = process.argv.includes("--quick");
const remote = envName !== "local";
if (remote && envName !== "staging") throw new Error("Only local and staging are approved benchmark targets");

const root = new URL("../", import.meta.url).pathname;
const project = loadProjectConfig(root);
const environment = resolveEnvironment(project, envName);
const tenant = environment.tenants.find(({ id }) => id === "tenant-a");
const worker = tenant && workerEnvironment(project.workers.tenant, tenant.env);
if (!tenant || !worker) throw new Error("tenant-a must be declared");

const sizes: Sizes = remote
	? { concurrencies: [1, 4], crud: 10, query: 6, health: 6 }
	: quick
		? { concurrencies: [1, 4], crud: 20, query: 10, health: 20 }
		: { concurrencies: [1, 8], crud: 200, query: 100, health: 200 };
const fixtureSizes = remote ? [] : quick ? [1_000] : [1_000, 10_000];
const signalSamples = remote ? 5 : quick ? 5 : 20;
const drainEvents = quick ? 100 : 1_000;
const budget = remote ? 200 : Number.MAX_SAFE_INTEGER;

const sql = (statement: string) =>
	queryD1(
		project.workers.tenant,
		tenant.env,
		environment,
		statement,
		undefined,
		join(project.workers.tenant, ".wrangler", `state-${tenant.id}`),
	);

const signIn = async () => {
	if (!remote) return (await signInLocally("alice@example.test")).token;
	const secrets = readSecretsFile(environment.secretsFile ?? "").values;
	const response = await fetch(
		`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${secrets.FIREBASE_API_KEY}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				email: "alice@example.test",
				password: secrets.STAGING_PASSWORD_ALICE,
				returnSecureToken: true,
			}),
		},
	);
	const { idToken } = (await response.json()) as { idToken?: string };
	if (idToken === undefined) throw new Error("alice could not sign in");
	return idToken;
};

// Up to `rows` fixture policies in all; the bulk insert writes no outbox events.
const growFixture = (rows: number, run: string) => {
	const now = new Date().toISOString();
	const [row] = sql("select count(*) as rows from policies");
	const existing = Number(row?.rows ?? 0);
	if (existing >= rows) return;
	sql(
		`with recursive n(i) as (select ${existing + 1} union all select i + 1 from n where i < ${rows}) insert into policies (id, number, holder, status, premium, created, updated) select 'bench-${run}-' || i, 'BENCH-F-${run}-' || i, 'Benchmark Holder', case i % 3 when 0 then 'pending' when 1 then 'active' else 'cancelled' end, i % 5000, '${now}', '${now}' from n`,
	);
};

// Outbox rows stay for normal retention: removing the newest would leave max(seq)
// behind the realtime revision, and provisioning would report stale signals.
const cleanUp = async () => {
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			sql("delete from policies where number like 'BENCH-%'");
			return true;
		} catch (error) {
			console.error(`Removing the BENCH- records failed (attempt ${attempt} of 3): ${String(error)}`);
			await new Promise((resolve) => setTimeout(resolve, 5_000));
		}
	}
	return false;
};

// Memory and CPU of the local workerd processes; a remote Worker exposes neither here.
const workerdUsage = () => {
	const lines = execFileSync("ps", ["-A", "-o", "rss=,time=,comm="], { encoding: "utf8" })
		.split("\n")
		.filter((line) => line.includes("workerd"));
	const memory = lines.reduce((total, line) => total + Number(line.trim().split(/\s+/)[0]), 0);
	return {
		processes: lines.length,
		rssMiB: Math.round(memory / 1024),
		cpuTimes: lines.map((l) => l.trim().split(/\s+/)[1]),
	};
};

const tenantUrl = remote ? workerUrl(environment, worker.workerName) : `http://localhost:${tenant.port}`;
const health = await fetch(`${tenantUrl}/health`).catch(() => null);
if (health?.status !== 200)
	throw new Error(`${tenantUrl} is not answering; ${remote ? "check staging" : "run pnpm dev:stack"}`);

const token = await signIn();
const target: Target = { url: tenantUrl, token, budget, sent: 1 };
const run = Date.now().toString(36);
const revisionUrl = remote
	? `${worker.vars.FIREBASE_DATABASE_URL}/collections/policies.json?auth=${token}`
	: `${databaseEmulator}/collections/policies.json?ns=${namespace("tenant-a")}&auth=${token}`;

const results: Stats[] = [];
let signal: SignalLatency | null = null;
let drain: DrainResult | null = null;
let failure: unknown = null;
try {
	results.push(...(await benchmarkCrud(target, sizes, run)));
	if (fixtureSizes.length === 0) results.push(...(await benchmarkQueries(target, sizes)));
	for (const rows of fixtureSizes) {
		growFixture(rows, run);
		results.push(...(await benchmarkQueries(target, sizes)));
	}
	signal = await signalLatency(target, revisionUrl, signalSamples, run);
	if (!remote) drain = await outboxDrain(target, sql, drainEvents, run);
} catch (error) {
	failure = error;
}
// Lets delivery triggered by the last writes finish first.
await new Promise((resolve) => setTimeout(resolve, 3_000));
const cleaned = await cleanUp();

const bundles: BundleResult[] = remote
	? []
	: [measureBundle("tenant", project.workers.tenant, tenant.env), measureBundle("global", project.workers.global)];

const wranglerVersion = spawnSync("pnpm", ["exec", "wrangler", "--version"], {
	cwd: project.workers.tenant,
	encoding: "utf8",
})
	.stdout.trim()
	.split("\n")
	.at(-1);

const report = {
	environment: {
		target: remote ? `${worker.workerName} (deployed)` : "local workerd and D1, RTDB and Auth emulators",
		date: new Date().toISOString(),
		commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
		client: `${cpus()[0]?.model}, ${Math.round(totalmem() / 1024 ** 3)} GiB, ${platform()} ${release()}, Node ${process.version}`,
		wrangler: wranglerVersion,
		workerRequests: target.sent,
	},
	results,
	signal,
	drain,
	bundles,
	resources: remote ? null : workerdUsage(),
};

console.log(`\n${JSON.stringify(report.environment, null, 2)}\n\n${table(results)}\n`);
console.log(`Write to realtime signal: ${JSON.stringify(signal)}`);
console.log(`Outbox drain: ${JSON.stringify(drain)}`);
console.log(`Bundles: ${JSON.stringify(bundles)}`);
console.log(`Resources: ${JSON.stringify(report.resources)}`);
if (!quick) {
	const dir = join(root, "benchmarks", "results");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${envName}.json`), `${JSON.stringify(report, null, "\t")}\n`);
}
const errors = results.reduce((total, { errors }) => total + errors, 0);
const missed = signal?.timeouts ?? 0;
if (failure !== null) console.error(`The run stopped early: ${String(failure)}`);
if (!cleaned) console.error(`BENCH- records are still on ${tenantUrl}; remove them with SQL.`);
const ok = errors === 0 && missed === 0 && failure === null && cleaned;
console.log(ok ? "Benchmarks finished without errors." : `${errors} request error(s), ${missed} signal timeout(s).`);
process.exitCode = ok ? 0 : 1;
