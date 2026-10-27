import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig, resolveEnvironment } from "../../packages/cli/src/project-config.ts";
import { readSecretsFile } from "../../packages/cli/src/secrets-file.ts";
import { workerEnvironment, workerUrl } from "../../packages/cli/src/services/environment.ts";

// The S-5-2-01 journey (SEGU-220): one user through the operator CLI's
// administration, checking at every step that the tenant API and the user's
// realtime grant in tenant-a match what the operator did.
//
//   node tests/fixtures/admin-journey.ts                 local: against `takebase dev`, with a new user
//   node tests/fixtures/admin-journey.ts --env staging   staging: the `probe` user only, created by no one here
//
// The user's own grant is read with their own token, which the database rules
// allow (null means no realtime access). Nothing secret is printed.

const envName =
	(process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : undefined) ?? "local";
const root = new URL("../../", import.meta.url).pathname;
const project = loadProjectConfig(root);
const environment = resolveEnvironment(project, envName);
const tenant = environment.tenants.find(({ id }) => id === "tenant-a");
if (!tenant) throw new Error("tenant-a is not declared");

const tenantEnv = workerEnvironment(project.workers.tenant, tenant.env);
const globalEnv = workerEnvironment(project.workers.global, environment.globalEnv);
if (!tenantEnv || !globalEnv) throw new Error("tenant-a or the global Worker has no Wrangler environment");
const tenantUrl = environment.remote ? workerUrl(environment, tenantEnv.workerName) : `http://localhost:${tenant.port}`;
const globalUrl = environment.remote
	? workerUrl(environment, globalEnv.workerName)
	: `http://localhost:${environment.globalPort}`;
const databaseUrl = tenantEnv.vars.FIREBASE_DATABASE_URL ?? "";
const namespace = tenantEnv.vars.FIREBASE_DATABASE_NAMESPACE;
const secrets = environment.remote ? readSecretsFile(environment.secretsFile ?? "").values : {};
const identityToolkit = environment.remote
	? `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${secrets.FIREBASE_API_KEY}`
	: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099"}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`;

let failures = 0;
const expect = (label: string, ok: boolean, detail: string) => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}`);
};

const cli = (...args: string[]) => {
	const result = spawnSync(process.execPath, [join(root, "packages/cli/src/bin.ts"), ...args, "--env", envName], {
		cwd: root,
		encoding: "utf8",
	});
	const output = `${result.stdout}${result.stderr}`.trim();
	console.log(`     $ takebase ${args.join(" ")} --env ${envName}  (exit ${result.status})`);
	for (const line of output.split("\n")) console.log(`       ${line}`);
	return { status: result.status ?? 1, output };
};

const signIn = async (email: string, password: string) => {
	const response = await fetch(identityToolkit, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password, returnSecureToken: true }),
	});
	const body = (await response.json()) as { idToken?: string; localId?: string };
	if (!body.idToken || !body.localId) throw new Error(`Sign-in failed for ${email}`);
	return { token: body.idToken, uid: body.localId };
};

const status = async (url: string, token: string, method = "GET", body?: unknown) => {
	const response = await fetch(url, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	await response.body?.cancel();
	return response.status;
};
const records = (token: string) => status(`${tenantUrl}/api/collections/policies/records?perPage=1`, token);
const openSession = (token: string) => status(`${tenantUrl}/api/realtime/session`, token, "POST");
// The user's own realtime grant in tenant-a, read as that user.
const grant = async (uid: string, token: string) => {
	const query = new URLSearchParams({ auth: token, ...(namespace ? { ns: namespace } : {}) });
	const response = await fetch(`${databaseUrl}/access/members/${uid}.json?${query}`);
	return response.ok ? ((await response.json()) as { rev?: number } | null) : null;
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The journey's user: a new one locally; the existing `probe` user on staging.
const user = async () => {
	if (environment.remote) {
		const password = secrets.STAGING_PASSWORD_PROBE;
		if (!password) throw new Error("STAGING_PASSWORD_PROBE is missing from the secrets file");
		return { email: "probe@example.test", password };
	}
	const dir = mkdtempSync(join(tmpdir(), "takebase-journey-"));
	const email = `journey-${Date.now().toString(36)}@example.test`;
	const created = cli("user", "create", "--email", email, "--password-file", join(dir, "password"));
	expect("operator creates the user", created.status === 0, email);
	const password = readFileSync(join(dir, "password"), "utf8").trim();
	rmSync(dir, { recursive: true, force: true });
	return { email, password };
};

console.log(`-- S-5-2-01 in "${envName}": tenant-a at ${tenantUrl}`);
const { email, password } = await user();
let session = await signIn(email, password);
const { uid } = session;
// Start from no membership (a staging probe may hold one from an earlier run).
cli("tenant", "user", "remove", "tenant-a", uid);
session = await signIn(email, password);
expect("not a member yet: the API refuses", (await records(session.token)) === 403, "403 expected");

console.log("-- membership and role");
expect(
	"operator adds the agent role",
	cli("tenant", "user", "add", "tenant-a", uid, "--role", "agent").status === 0,
	"",
);
expect("the API accepts the member", (await records(session.token)) === 200, "200 expected");
expect("a realtime session opens", (await openSession(session.token)) === 200, "200 expected");
const first = await grant(uid, session.token);
expect("the realtime grant exists", typeof first?.rev === "number", JSON.stringify(first));

console.log("-- escalation is refused");
expect(
	"the member cannot make themself admin",
	(await status(`${globalUrl}/api/admin/tenants/tenant-a/members`, session.token, "POST", { uid, role: "admin" })) ===
		403,
	"403 expected",
);
expect(
	"a made-up invitation token gives nothing",
	(await status(`${globalUrl}/api/invites/redeem`, session.token, "POST", { token: "x".repeat(43) })) === 404,
	"404 expected",
);

console.log("-- removal");
const removed = cli("tenant", "user", "remove", "tenant-a", uid);
expect(
	"operator removes the member",
	removed.status === 0 && removed.output.includes("revoked"),
	"revocation delivered",
);
expect("the API refuses the removed member", (await records(session.token)) === 403, "403 expected");
expect("the realtime grant is gone", (await grant(uid, session.token)) === null, "null expected");

console.log("-- added again, then sessions revoked");
cli("tenant", "user", "add", "tenant-a", uid, "--role", "agent");
expect("re-added: a session opens again", (await openSession(session.token)) === 200, "200 expected");
expect("re-added: granted again", (await grant(uid, session.token)) !== null, "a grant expected");
const revoked = cli("user", "revoke-sessions", uid);
expect("operator revokes the sessions", revoked.status === 0, "");
expect("the old sign-in is refused", (await records(session.token)) === 401, "401 expected");
expect("the realtime grant is gone", (await grant(uid, session.token)) === null, "null expected");
await wait(1_500);
session = await signIn(email, password);
expect("a fresh sign-in is accepted", (await records(session.token)) === 200, "200 expected");
expect("and its session opens", (await openSession(session.token)) === 200, "200 expected");
expect("and is granted again", (await grant(uid, session.token)) !== null, "a grant expected");

console.log("-- disabled, then enabled");
expect("operator disables the user", cli("user", "disable", uid).status === 0, "");
expect("the API refuses the disabled user", (await records(session.token)) === 401, "401 expected");
expect("the realtime grant is gone", (await grant(uid, session.token)) === null, "null expected");
cli("user", "enable", uid);
await wait(1_500);
session = await signIn(email, password);
expect("enabled: a fresh sign-in is accepted", (await records(session.token)) === 200, "200 expected");

console.log("-- clean up");
expect("operator removes the member again", cli("tenant", "user", "remove", "tenant-a", uid).status === 0, "");
console.log(failures === 0 ? "All S-5-2-01 checks passed." : `${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
