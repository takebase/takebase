import { spawnSync } from "node:child_process";
import { databaseEmulator, globalPort, namespace, signIn, signUp, tenantUrl, users } from "./tenants.ts";

// The S-7-1-01 boundary journey (SEGU-228), against the real two-tenant stack:
// tokens replayed across tenants, escalation, anonymous callers, realtime
// channels and a removed member. Run it against `pnpm dev:stack`. Forged
// signatures are not checked here: the local stack trusts the Auth emulator's
// unsigned tokens by design, and packages/core tests real signature checks.

const globalUrl = tenantUrl(globalPort);
const a = tenantUrl(8788);
const b = tenantUrl(8789);

let failures = 0;
const expect = (label: string, ok: boolean, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${detail}`}`);
};

const send = (url: string, token: string | null, init: RequestInit = {}, headers: Record<string, string> = {}) =>
	fetch(url, {
		...init,
		headers: {
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
			...(init.body === undefined ? {} : { "content-type": "application/json" }),
			...headers,
		},
	});
const status = async (url: string, token: string | null, init?: RequestInit, headers?: Record<string, string>) => {
	const response = await send(url, token, init, headers);
	await response.body?.cancel();
	return response.status;
};
const refused = async (label: string, expected: number, url: string, token: string | null, init?: RequestInit) => {
	const actual = await status(url, token, init);
	expect(label, actual === expected, `HTTP ${actual}`);
};
// A tenant's realtime channel, read as this user over the emulator's REST API.
const channel = (tenant: "tenant-a" | "tenant-b", token: string) =>
	status(`${databaseEmulator}/collections.json?ns=${namespace(tenant)}&auth=${token}`, null);

const policies = "/api/collections/policies/records";
const post = (body?: unknown): RequestInit => ({
	method: "POST",
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const bob = await signIn(users.bob.email);
const carol = await signIn(users.carol.email);

console.log("\nInvalid tokens");
await refused("a malformed token is refused by a tenant", 401, `${a}${policies}`, "not-a-token");
await refused("a malformed token is refused by the global Worker", 401, `${globalUrl}/api/tenants`, "not-a-token");

console.log("\nTenant URL tampering and replay");
expect("bob's token works at his tenant", (await status(`${a}${policies}`, bob.token)) === 200);
await refused("bob's token is refused at another tenant's list", 403, `${b}${policies}?perPage=1`, bob.token);
await refused("bob's token cannot create at another tenant", 403, `${b}${policies}`, bob.token, post({}));
await refused("bob's token cannot open another tenant's realtime", 403, `${b}/api/realtime/session`, bob.token, post());
const tenants = (await (await send(`${globalUrl}/api/tenants`, bob.token)).json()) as {
	tenants: { tenant: { id: string } }[];
};
expect(
	"the global Worker lists only bob's tenant",
	tenants.tenants.length === 1 && tenants.tenants[0]?.tenant.id === "tenant-a",
);

console.log("\nEscalation");
const asAdmin = { "x-roles": "admin", "x-user-id": carol.uid, "x-tenant-id": "tenant-a" };
const spoofed = await status(`${a}/api/admin/diagnostics`, bob.token, undefined, asAdmin);
expect("headers naming a role or user are ignored", spoofed === 403, `HTTP ${spoofed}`);
await refused(
	"bob cannot make himself an admin",
	403,
	`${globalUrl}/api/admin/tenants/tenant-a/members`,
	bob.token,
	post({ uid: bob.uid, role: "admin" }),
);
await refused("an admin of tenant-a is no admin at tenant-b", 403, `${b}/api/admin/diagnostics`, carol.token);
await refused("nor in the global Worker", 403, `${globalUrl}/api/admin/tenants/tenant-b/members`, carol.token);

console.log("\nDiagnostics, secrets and backups");
for (const path of ["diagnostics", "secrets", "collections"]) {
	await refused(`anonymous ${path}`, 401, `${a}/api/admin/${path}`, null);
	await refused(`a member's ${path}`, 403, `${a}/api/admin/${path}`, bob.token);
}
await refused("anonymous record count", 401, `${a}${policies}?perPage=1`, null);
await refused("anonymous backups", 401, `${globalUrl}/api/admin/tenants/tenant-a/backups`, null);
await refused("a member's backups", 403, `${globalUrl}/api/admin/tenants/tenant-a/backups`, bob.token);

console.log("\nAnonymous delivery routes");
for (const path of ["reconcile", "dispatch"]) {
	const response = await send(`${a}/api/realtime/${path}`, null, post());
	const text = await response.text();
	expect(`anonymous ${path} reveals no counts`, text === '{"ok":true}', `HTTP ${response.status} ${text}`);
}

console.log("\nA removed member");
const email = `removed-${Date.now()}@example.test`;
const removedUid = await signUp(email);
const removed = await signIn(email);
const members = `${globalUrl}/api/admin/tenants/tenant-a/members`;
expect(
	"carol adds the member",
	(await status(members, carol.token, post({ uid: removedUid, role: "member" }))) === 201,
);
expect("the member opens realtime", (await status(`${a}/api/realtime/session`, removed.token, post())) === 200);
expect("the member reads the channel", (await channel("tenant-a", removed.token)) === 200);
expect("the member cannot read another tenant's channel", (await channel("tenant-b", removed.token)) === 401);
expect(
	"carol removes the member",
	(await status(`${members}/${removedUid}`, carol.token, { method: "DELETE" })) === 200,
);
await refused("the next API request is refused", 403, `${a}${policies}`, removed.token);
await status(`${a}/api/realtime/reconcile`, null, post());
expect("the channel is closed", (await channel("tenant-a", removed.token)) === 401);
await refused("realtime stays closed", 403, `${a}/api/realtime/session`, removed.token, post());

console.log("\nA tenant registered again over its old realtime database");
// `tenant delete` keeps the database and the new registration restarts the
// revision, leaving a revocation ahead of it, as injected here on tenant-b.
const alice = await signIn(users.alice.email);
const revocation = `${databaseEmulator}/access/revoked/${alice.uid}.json?ns=${namespace("tenant-b")}`;
await status(revocation, "owner", { method: "PUT", body: "999999" });
const session = () => status(`${b}/api/realtime/session`, alice.token, post());
await refused("the session cannot be granted", 503, `${b}/api/realtime/session`, alice.token, post());
const emulators = { FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099", FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9000" };
const provision = spawnSync(process.execPath, ["packages/cli/src/bin.ts", "tenant", "provision", "tenant-b"], {
	cwd: new URL("../../", import.meta.url).pathname,
	encoding: "utf8",
	env: { ...process.env, ...emulators },
});
expect("provisioning clears it", provision.status === 0, provision.status === 0 ? "" : provision.stderr.trim());
expect("the provision output names the step", /realtime access/.test(provision.stdout));
const reopened = await session();
expect("the member's session opens again", reopened === 200, `HTTP ${reopened}`);

console.log(failures === 0 ? "All S-7-1-01 boundary checks passed." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
