import { execFileSync } from "node:child_process";

// The local two-tenant milestone fixture: users in the Auth emulator and their
// memberships in local global D1. The tenants themselves come from
// takebase.jsonc and are provisioned by `takebase dev`. Emulator and local D1
// only; the password below exists nowhere else.

export const password = "local-only-password";
export const authEmulator = "http://127.0.0.1:9099";
export const databaseEmulator = "http://127.0.0.1:9000";
export const appOrigin = "http://localhost:5173";
export const adminOrigin = "http://localhost:5174";
export const globalPort = 8787;

export const tenants = [
	{ id: "tenant-a", name: "Tenant A", port: 8788 },
	{ id: "tenant-b", name: "Tenant B", port: 8789 },
] as const;

export type TenantId = (typeof tenants)[number]["id"];

// alice is an agent (may create policies) in both tenants; bob is a plain
// member of tenant A only; carol administers tenant A (the admin's journey,
// SEGU-222) and is a plain member of tenant B.
export const users = {
	alice: { email: "alice@example.test", roles: { "tenant-a": "agent", "tenant-b": "agent" } },
	bob: { email: "bob@example.test", roles: { "tenant-a": "member" } },
	carol: { email: "carol@example.test", roles: { "tenant-a": "admin", "tenant-b": "member" } },
} as const satisfies Record<string, { email: string; roles: Partial<Record<TenantId, string>> }>;

export const namespace = (tenant: TenantId) => `demo-takebase-${tenant}`;
export const tenantUrl = (port: number) => `http://localhost:${port}`;

const root = new URL("../../", import.meta.url).pathname;
export const workerDir = (name: "global" | "tenant") => `${root}examples/workers/${name}`;

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
	// Uids change with every emulator start (global D1 survives it), so
	// memberships are rewritten. Each fixture membership has a fixed id and
	// only its subject is updated: global D1 never lets a tenant lose its last
	// admin, so carol's admin row is kept, never deleted and re-added. Other
	// admins are removed only where carol (the new uid) is admin by then. The
	// access-revision triggers move each tenant's revision forward.
	statements.push(
		`delete from memberships where tenant_id in (${tenants.map(({ id }) => text(id)).join(", ")}) and role != 'admin';`,
	);
	const admins = new Set<string>();
	for (const [name, { roles }] of Object.entries(users) as [keyof typeof users, (typeof users)[keyof typeof users]][]) {
		for (const [tenant, role] of Object.entries(roles)) {
			if (role === "admin") admins.add(tenant);
			// Global D1 refuses a membership with an undeclared role (`admin` is built in).
			statements.push(
				`insert or ignore into tenant_roles (tenant_id, name, created) values (${text(tenant)}, ${text(role)}, ${now});`,
				`insert into memberships (id, tenant_id, provider, subject, role, created, updated) values (${text(`fixture-${name}-${tenant}-${role}`)}, ${text(tenant)}, 'firebase', ${text(uids[name])}, ${text(role)}, ${now}, ${now}) on conflict(id) do update set subject = excluded.subject, updated = excluded.updated;`,
			);
		}
	}
	for (const tenant of admins) {
		statements.push(
			`delete from memberships where tenant_id = ${text(tenant)} and role = 'admin' and id not like 'fixture-%';`,
		);
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

// Deletes a policy straight from a tenant's local D1 (`takebase dev` keeps
// one state directory per tenant). Policies deny every delete through the
// API, so a test that created one cleans up here; the specs share one stack.
export const removePolicy = (tenant: TenantId, id: string) =>
	wrangler(workerDir("tenant"), [
		"d1",
		"execute",
		"DB",
		"--local",
		"--env",
		tenant,
		"--persist-to",
		`.wrangler/state-${tenant}`,
		"--command",
		`delete from policies where id = ${text(id)};`,
	]);

// Seeds the fixture users and memberships, run by `takebase dev --seed` after
// it provisioned both tenants (dispatchers, rules, local D1, registration).
// Tenants are forced active and memberships rewritten, because uids change
// with every emulator start; the access-revision triggers move each tenant's
// revision forward. Returns the users' uids.
export const seed = async () => {
	const uids = Object.fromEntries(
		await Promise.all(Object.entries(users).map(async ([name, { email }]) => [name, await signUp(email)])),
	) as Record<keyof typeof users, string>;
	wrangler(workerDir("global"), ["d1", "execute", "DB", "--local", "--command", globalSeed(uids)]);
	return uids;
};
