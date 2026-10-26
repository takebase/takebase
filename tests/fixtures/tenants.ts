import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { databaseRules } from "../../packages/adapter-firebase/src/rules.ts";

// The local two-tenant milestone fixture: users in the Auth emulator, each
// tenant's dispatcher and rendered rules in its own RTDB namespace, and the
// tenants and memberships in local global D1. Emulator and local D1 only; the
// passwords below exist nowhere else.

export const password = "local-only-password";
export const authEmulator = "http://127.0.0.1:9099";
export const databaseEmulator = "http://127.0.0.1:9000";
export const appOrigin = "http://localhost:5173";
export const globalPort = 8787;

export const tenants = [
	{ id: "tenant-a", name: "Tenant A", port: 8788 },
	{ id: "tenant-b", name: "Tenant B", port: 8789 },
] as const;

export type TenantId = (typeof tenants)[number]["id"];

// alice is an agent (may create policies) in both tenants; bob is a plain
// member of tenant A only.
export const users = {
	alice: { email: "alice@example.test", roles: { "tenant-a": "agent", "tenant-b": "agent" } },
	bob: { email: "bob@example.test", roles: { "tenant-a": "member" } },
} as const satisfies Record<string, { email: string; roles: Partial<Record<TenantId, string>> }>;

export const namespace = (tenant: TenantId) => `demo-takebase-${tenant}`;
export const dispatcherEmail = (tenant: TenantId) => `takebase-dispatcher+${tenant}@example.test`;
export const tenantUrl = (port: number) => `http://localhost:${port}`;

const root = new URL("../../", import.meta.url).pathname;
export const workerDir = (name: "global" | "tenant") => `${root}examples/workers/${name}`;
// One local state directory per tenant Worker process: two `wrangler dev`
// processes sharing one directory lock each other's SQLite files.
export const tenantState = (tenant: TenantId) => `.wrangler/state-${tenant}`;

const signUp = async (email: string) => {
	const response = await fetch(`${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password, returnSecureToken: true }),
	});
	if (response.status !== 200) throw new Error(`The Auth emulator did not create ${email}: ${await response.text()}`);
	return ((await response.json()) as { localId: string }).localId;
};

// Signs a fixture user in through the Auth emulator, as a second device would.
export const signIn = async (email: string) => {
	const response = await fetch(
		`${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password, returnSecureToken: true }),
		},
	);
	if (response.status !== 200) throw new Error(`The Auth emulator did not sign in ${email}: ${await response.text()}`);
	const { idToken, localId } = (await response.json()) as { idToken: string; localId: string };
	return { token: idToken, uid: localId };
};

const loadRules = async (tenant: TenantId, dispatcherUid: string) => {
	const response = await fetch(`${databaseEmulator}/.settings/rules.json?ns=${namespace(tenant)}`, {
		method: "PUT",
		headers: { authorization: "Bearer owner" },
		body: JSON.stringify(databaseRules(dispatcherUid)),
	});
	if (response.status !== 200) throw new Error(`Rules for ${tenant} did not load: ${await response.text()}`);
};

const wrangler = (cwd: string, args: string[]) =>
	execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd, stdio: ["ignore", "ignore", "inherit"] });

// Values are fixed strings and emulator uids (letters and digits).
const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

const globalSeed = (uids: Record<keyof typeof users, string>) => {
	const now = text(new Date().toISOString());
	const statements = tenants.map(
		({ id, name, port }) =>
			`insert into tenants (id, name, url, status, created, updated) values (${text(id)}, ${text(name)}, ${text(tenantUrl(port))}, 'active', ${now}, ${now}) on conflict(id) do update set name = excluded.name, url = excluded.url, status = 'active', updated = excluded.updated;`,
	);
	// Uids change with every emulator start, so memberships are rewritten. The
	// access-revision triggers move each tenant's revision forward.
	statements.push(`delete from memberships where tenant_id in (${tenants.map(({ id }) => text(id)).join(", ")});`);
	for (const [name, { roles }] of Object.entries(users) as [keyof typeof users, (typeof users)[keyof typeof users]][]) {
		for (const [tenant, role] of Object.entries(roles)) {
			statements.push(
				`insert into memberships (id, tenant_id, provider, subject, role, created, updated) values (${text(crypto.randomUUID())}, ${text(tenant)}, 'firebase', ${text(uids[name])}, ${text(role)}, ${now}, ${now});`,
			);
		}
	}
	return statements.join("\n");
};

// Removes a user from a tenant in local global D1, as an administrator would.
export const removeMembership = (uid: string, tenant: TenantId) =>
	wrangler(workerDir("global"), [
		"d1",
		"execute",
		"DB",
		"--local",
		"--command",
		`delete from memberships where tenant_id = ${text(tenant)} and provider = 'firebase' and subject = ${text(uid)};`,
	]);

// Seeds a freshly started emulator pair plus the local D1 databases the
// `wrangler dev` processes use: global D1 keeps its tenants (upserted, so access
// revisions only grow); tenant D1 is recreated. Returns the users' uids.
export const seed = async () => {
	const uids = Object.fromEntries(
		await Promise.all(Object.entries(users).map(async ([name, { email }]) => [name, await signUp(email)])),
	) as Record<keyof typeof users, string>;
	for (const { id } of tenants) await loadRules(id, await signUp(dispatcherEmail(id)));

	wrangler(workerDir("global"), ["d1", "migrations", "apply", "DB", "--local"]);
	wrangler(workerDir("global"), ["d1", "execute", "DB", "--local", "--command", globalSeed(uids)]);
	// Tenant data starts empty on every run, like the emulators: only the stack's
	// own state directories are removed, never the default `.wrangler/state`.
	for (const { id } of tenants) {
		rmSync(`${workerDir("tenant")}/${tenantState(id)}`, { recursive: true, force: true });
		wrangler(workerDir("tenant"), [
			"d1",
			"migrations",
			"apply",
			"DB",
			"--local",
			"--env",
			id,
			"--persist-to",
			tenantState(id),
		]);
	}
	return uids;
};
