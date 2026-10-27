import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig, resolveEnvironment } from "../../packages/cli/src/project-config.ts";
import { readSecretsFile } from "../../packages/cli/src/secrets-file.ts";
import { queryD1, workerEnvironment, workerUrl } from "../../packages/cli/src/services/environment.ts";

// The S-5-3-01 journey (SEGU-221): a notification whose delivery failed is
// inspected and retried by an authorized admin, the change reaches realtime
// as a revision only, and the record is refetched through the collection
// rules. Callers without this tenant's admin role can neither inspect nor
// retry. Nothing secret is printed, and the captured output is checked for it.
//
//   node tests/fixtures/wire-journey.ts                 local: against `takebase dev`, with a new admin user
//   node tests/fixtures/wire-journey.ts --env staging   staging: `probe` as tenant-a admin; alice and bob as seeded
//
// The delivery failure is injected with SQL on tenant-a's D1: a dead outbox
// event (10 attempts) for alice's record at a new revision, as a committed
// change whose delivery used up its retries would leave it. No Worker code
// has a fault switch.

const envName =
	(process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : undefined) ?? "local";
const root = new URL("../../", import.meta.url).pathname;
const project = loadProjectConfig(root);
const environment = resolveEnvironment(project, envName);
const tenantA = environment.tenants.find(({ id }) => id === "tenant-a");
const tenantB = environment.tenants.find(({ id }) => id === "tenant-b");
if (!tenantA || !tenantB) throw new Error("tenant-a and tenant-b must be declared");

const urlOf = (tenant: typeof tenantA) => {
	const worker = workerEnvironment(project.workers.tenant, tenant.env);
	if (!worker) throw new Error(`tenant ${tenant.id} has no Wrangler environment`);
	return {
		url: environment.remote ? workerUrl(environment, worker.workerName) : `http://localhost:${tenant.port}`,
		databaseUrl: worker.vars.FIREBASE_DATABASE_URL ?? "",
		namespace: worker.vars.FIREBASE_DATABASE_NAMESPACE,
	};
};
const a = urlOf(tenantA);
const b = urlOf(tenantB);
const secrets = environment.remote ? readSecretsFile(environment.secretsFile ?? "").values : {};
const identityToolkit = environment.remote
	? `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${secrets.FIREBASE_API_KEY}`
	: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099"}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`;

// Everything the journey received or printed, checked for secrets at the end.
let captured = "";
const forbidden: string[] = [];
let failures = 0;
const expect = (label: string, ok: boolean, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${detail}`}`);
};

const cli = (...args: string[]) => {
	const result = spawnSync(process.execPath, [join(root, "packages/cli/src/bin.ts"), ...args, "--env", envName], {
		cwd: root,
		encoding: "utf8",
	});
	const output = `${result.stdout}${result.stderr}`.trim();
	captured += output;
	console.log(`     $ takebase ${args.join(" ")} --env ${envName}  (exit ${result.status})`);
	for (const line of output.split("\n")) console.log(`       ${line}`);
	return { status: result.status ?? 1, output };
};

// tenant-a's D1, through Wrangler (`takebase dev`'s per-tenant state locally).
const tenantSql = (sql: string) =>
	queryD1(
		project.workers.tenant,
		tenantA.env,
		environment,
		sql,
		undefined,
		join(project.workers.tenant, ".wrangler", `state-${tenantA.id}`),
	);
const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

const signIn = async (email: string, password: string) => {
	forbidden.push(password);
	const response = await fetch(identityToolkit, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password, returnSecureToken: true }),
	});
	const body = (await response.json()) as { idToken?: string; localId?: string };
	if (!body.idToken || !body.localId) throw new Error(`Sign-in failed for ${email}`);
	forbidden.push(body.idToken);
	return { token: body.idToken, uid: body.localId };
};

const call = async (url: string, token: string | null, method = "GET", body?: unknown) => {
	const response = await fetch(url, {
		method,
		headers: {
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const raw = await response.text();
	captured += raw;
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		json = undefined;
	}
	return { status: response.status, raw, json };
};

// The `policies` signal in tenant-a's Realtime Database, read as a granted member.
const signal = async (token: string) => {
	const query = new URLSearchParams({ auth: token, ...(a.namespace ? { ns: a.namespace } : {}) });
	const response = await fetch(`${a.databaseUrl}/collections/policies.json?${query}`);
	const raw = await response.text();
	captured += raw;
	return { ok: response.ok, raw, value: response.ok ? (JSON.parse(raw) as { revision?: number } | null) : null };
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const password = (name: "ALICE" | "BOB" | "PROBE") => {
	const value = secrets[`STAGING_PASSWORD_${name}`];
	if (!value) throw new Error(`STAGING_PASSWORD_${name} is missing from the secrets file`);
	return value;
};

// The journey's admin: a new user locally; the existing `probe` user on staging.
const adminUser = () => {
	if (environment.remote) return { email: "probe@example.test", password: password("PROBE") };
	const dir = mkdtempSync(join(tmpdir(), "takebase-wire-journey-"));
	const email = `wire-${Date.now().toString(36)}@example.test`;
	const created = cli("user", "create", "--email", email, "--password-file", join(dir, "password"));
	expect("operator creates the admin user", created.status === 0, email);
	const value = readFileSync(join(dir, "password"), "utf8").trim();
	rmSync(dir, { recursive: true, force: true });
	return { email, password: value };
};
const fixturePassword = (name: "ALICE" | "BOB") => (environment.remote ? password(name) : "local-only-password");

console.log(`-- S-5-3-01 in "${envName}": tenant-a at ${a.url}`);
const adminAccount = adminUser();
const admin = await signIn(adminAccount.email, adminAccount.password);
const alice = await signIn("alice@example.test", fixturePassword("ALICE"));
const bob = await signIn("bob@example.test", fixturePassword("BOB"));
// Start from no membership (a staging probe may hold one from an earlier run).
cli("tenant", "user", "remove", "tenant-a", admin.uid);
expect(
	"operator makes the journey user an admin of tenant-a",
	cli("tenant", "user", "add", "tenant-a", admin.uid, "--role", "admin").status === 0,
);

console.log("-- a committed change, seen by alice's realtime session");
const created = await call(`${a.url}/api/collections/policies/records`, alice.token, "POST", {
	number: `WIRE-${Date.now().toString(36)}`,
	holder: "Wire Journey Holder",
	status: "pending",
});
const recordId = (created.json as { id?: string } | undefined)?.id ?? "";
expect("alice creates a policy", created.status === 201 && recordId !== "", `HTTP ${created.status}`);
expect("alice opens realtime", (await call(`${a.url}/api/realtime/session`, alice.token, "POST")).status === 200);
await wait(1_000);
const before = (await signal(alice.token)).value?.revision ?? 0;
expect("the policies signal has a revision", before > 0, `revision ${before}`);

console.log("-- injected delivery failure (SQL on tenant-a's D1)");
const eventId = `wire-journey-${Date.now().toString(36)}`;
const now = new Date().toISOString();
tenantSql(
	`insert into takebase_outbox (id, collection, operation, record_id, created, status, attempts, available_at) values (${text(eventId)}, 'policies', 'update', ${text(recordId)}, ${text(now)}, 'dead', 10, ${text(now)})`,
);
const [injected] = tenantSql(`select seq, status, attempts from takebase_outbox where id = ${text(eventId)}`);
const revision = Number(injected?.seq);
expect(
	"a dead event after 10 attempts, at a newer revision",
	injected?.status === "dead" && revision > before,
	`seq ${revision}`,
);

console.log("-- the operator and the tenant admin inspect it");
const status = cli("wire", "status", "tenant-a");
expect(
	"wire status lists it with its attempts",
	status.status === 0 && status.output.includes(eventId) && status.output.includes("10 attempts"),
);
const inspected = await call(`${a.url}/api/admin/diagnostics`, admin.token);
const dead = (inspected.json as { outbox?: { dead?: { id: string; attempts: number }[] } } | undefined)?.outbox?.dead;
expect(
	"the admin sees it in diagnostics",
	inspected.status === 200 && dead?.some((event) => event.id === eventId && event.attempts === 10) === true,
	`HTTP ${inspected.status}`,
);
expect("diagnostics carry no record id", !inspected.raw.includes(recordId) && !inspected.raw.includes("record_id"));

console.log("-- callers without this tenant's admin role are refused");
const retryBody = { ids: [eventId] };
expect(
	"bob (member) cannot inspect",
	(await call(`${a.url}/api/admin/diagnostics`, bob.token)).status === 403,
	"403 expected",
);
expect(
	"bob (member) cannot retry",
	(await call(`${a.url}/api/admin/outbox/retry`, bob.token, "POST", retryBody)).status === 403,
	"403 expected",
);
expect(
	"anonymous cannot retry",
	(await call(`${a.url}/api/admin/outbox/retry`, null, "POST", retryBody)).status === 401,
	"401 expected",
);
expect(
	"tenant-a's admin cannot inspect tenant-b",
	(await call(`${b.url}/api/admin/diagnostics`, admin.token)).status === 403,
	"403 expected",
);
const [still] = tenantSql(`select status from takebase_outbox where id = ${text(eventId)}`);
expect("the event is still dead", still?.status === "dead");

console.log("-- the admin retries it");
const retried = await call(`${a.url}/api/admin/outbox/retry`, admin.token, "POST", retryBody);
expect(
	"the retry revives exactly that event",
	retried.status === 200 && (retried.json as { revived?: number } | undefined)?.revived === 1,
	retried.raw,
);
let after = before;
for (let attempt = 0; attempt < 20 && after < revision; attempt++) {
	await wait(500);
	after = (await signal(alice.token)).value?.revision ?? after;
}
expect("realtime receives the new revision", after >= revision, `revision ${before} -> ${after}`);
const published = await signal(alice.token);
expect(
	"the signal is a revision only",
	JSON.stringify(Object.keys(published.value ?? {})) === '["revision"]' &&
		!published.raw.includes(recordId) &&
		!published.raw.includes("Wire Journey Holder"),
	published.raw,
);
const [delivered] = tenantSql(`select status from takebase_outbox where id = ${text(eventId)}`);
expect("the event is delivered", delivered?.status === "delivered");
const refetched = await call(`${a.url}/api/collections/policies/records/${recordId}`, alice.token);
expect(
	"alice refetches the record through the rules",
	refetched.status === 200 && refetched.raw.includes("Wire Journey Holder"),
	`HTTP ${refetched.status}`,
);
const test = cli("wire", "test", "tenant-a");
expect("wire test finds nothing owed", test.status === 0 && test.output.includes("0 dead"));

console.log("-- nothing secret in what the journey saw");
expect(
	"no token or password in any output",
	forbidden.every((secret) => secret.length < 6 || !captured.includes(secret)),
);

console.log("-- clean up");
const removed = cli("tenant", "user", "remove", "tenant-a", admin.uid);
expect(
	"the journey user leaves tenant-a (kept only if it is the last admin)",
	removed.status === 0 || removed.output.includes("last admin"),
);
console.log(failures === 0 ? "All S-5-3-01 checks passed." : `${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
