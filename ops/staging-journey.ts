import { execFileSync } from "node:child_process";
import {
	databaseUrl,
	dispatcherEmail,
	password,
	projectId,
	type Session,
	signIn,
	type Tenant,
	tenants,
	type UserName,
	users,
} from "./staging.ts";

// The staging journey (R-4-4-01), shared by the local run against real Firebase
// (Section C, staging-local.ts) and the deployed run (Section E,
// staging-cloudflare.ts): real identity → tenant discovery → protected create →
// RTDB signal → authorized refetch, plus negative auth and tenant isolation.
// Staging data is not reset between runs, so every check stands on its own:
// unique policy numbers, and isolation judged by what changed during this run.

// alice is an agent in both tenants; bob a plain member of tenant A.
export const roles: Record<UserName, Partial<Record<Tenant["id"], string>>> = {
	alice: { "tenant-a": "agent", "tenant-b": "agent" },
	bob: { "tenant-a": "member" },
	probe: {},
};

const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Global D1 seed: the tenants (upserted, so access revisions only grow) and the
// memberships, rewritten for the given uids.
export const seedStatements = (uids: Record<UserName, string>, tenantUrl: (tenant: Tenant) => string) => {
	const now = text(new Date().toISOString());
	const statements = tenants.map(
		(tenant) =>
			`insert into tenants (id, name, url, status, created, updated) values (${text(tenant.id)}, ${text(tenant.name)}, ${text(tenantUrl(tenant))}, 'active', ${now}, ${now}) on conflict(id) do update set name = excluded.name, url = excluded.url, status = 'active', updated = excluded.updated;`,
	);
	statements.push(
		`delete from memberships where tenant_id in (${tenants.map(({ id }) => text(id)).join(", ")}) and role != 'admin';`,
	);
	for (const [name, byTenant] of Object.entries(roles) as [UserName, Record<string, string>][]) {
		for (const [tenant, role] of Object.entries(byTenant)) {
			// Global D1 refuses a membership with an undeclared role.
			statements.push(
				`insert or ignore into tenant_roles (tenant_id, name, created) values (${text(tenant)}, ${text(role)}, ${now});`,
				`insert into memberships (id, tenant_id, provider, subject, role, created, updated) values (${text(crypto.randomUUID())}, ${text(tenant)}, 'firebase', ${text(uids[name])}, ${text(role)}, ${now}, ${now});`,
			);
		}
	}
	return statements.join("\n");
};

// One statement on the deployed staging global D1, as an administrator would.
const stagingGlobal = (statement: string) =>
	execFileSync(
		"pnpm",
		["exec", "wrangler", "d1", "execute", "DB", "--remote", "--env", "staging", "--command", statement],
		{
			cwd: new URL("../examples/workers/global", import.meta.url).pathname,
			stdio: ["ignore", "ignore", "inherit"],
		},
	);

export const removeStagingMembership = (uid: string, tenant: Tenant["id"]) =>
	stagingGlobal(
		`delete from memberships where tenant_id = ${text(tenant)} and provider = 'firebase' and subject = ${text(uid)};`,
	);

export const addStagingMembership = (uid: string, tenant: Tenant["id"], role: string) => {
	const now = text(new Date().toISOString());
	stagingGlobal(
		`insert or ignore into tenant_roles (tenant_id, name, created) values (${text(tenant)}, ${text(role)}, ${now}); insert into memberships (id, tenant_id, provider, subject, role, created, updated) values (${text(crypto.randomUUID())}, ${text(tenant)}, 'firebase', ${text(uid)}, ${text(role)}, ${now}, ${now}) on conflict do nothing;`,
	);
};

// Clears a tenant's change signals, as its dispatcher. Run whenever that tenant's
// D1 starts over: its revisions restart at 1, and the adapter ignores any
// revision not newer than the one in RTDB, so stale signals would hide every new
// change until the counter caught up.
export const resetSignals = async (tenant: Tenant) => {
	const { token } = await signIn(dispatcherEmail(tenant), password(`dispatcher-${tenant.id}`));
	const response = await fetch(`${databaseUrl(tenant)}/collections.json?shallow=true&auth=${token}`);
	if (!response.ok) throw new Error(`Reading ${tenant.id}'s signals failed: ${response.status}`);
	const names = Object.keys(((await response.json()) as Record<string, unknown> | null) ?? {});
	for (const name of names) {
		const deleted = await fetch(`${databaseUrl(tenant)}/collections/${encodeURIComponent(name)}.json?auth=${token}`, {
			method: "DELETE",
		});
		await deleted.body?.cancel();
		if (!deleted.ok) throw new Error(`Clearing ${tenant.id}'s ${name} signal failed: ${deleted.status}`);
	}
	return names;
};

export const signInAll = async () =>
	Object.fromEntries(
		await Promise.all(
			(Object.keys(users) as UserName[]).map(async (name) => [name, await signIn(users[name].email, password(name))]),
		),
	) as Record<UserName, Session>;

export const uidsOf = (sessions: Record<UserName, Session>) =>
	Object.fromEntries(Object.entries(sessions).map(([name, { uid }]) => [name, uid])) as Record<UserName, string>;

const call = async (url: string, token: string | null, method = "GET", body?: unknown) => {
	const response = await fetch(url, {
		method,
		headers: {
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: response.status, json };
};

const rtdb = (tenant: Tenant, path: string, session: Session) =>
	call(`${databaseUrl(tenant)}/${path}.json?auth=${session.token}`, null);

const revisionOf = (json: unknown) => (json as { revision?: unknown } | null)?.revision ?? null;

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

// What an emulator would issue: correct claims for this project, no signature.
const unsignedToken = (uid: string) => {
	const now = Math.floor(Date.now() / 1000);
	const claims = {
		iss: `https://securetoken.google.com/${projectId}`,
		aud: projectId,
		sub: uid,
		user_id: uid,
		iat: now,
		auth_time: now,
		exp: now + 3600,
	};
	return `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claims)}.`;
};

const tampered = (token: string) => {
	const [header, payload, signature = ""] = token.split(".");
	const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
	return `${header}.${payload}.${flipped}`;
};

// The global Worker answers { tenants: [{ tenant: { id }, roles }] }.
const tenantIds = (json: unknown) => {
	const list = (json as { tenants?: { tenant?: { id?: string } }[] } | null)?.tenants;
	return Array.isArray(list)
		? list
				.map((membership) => membership.tenant?.id)
				.sort()
				.join(",")
		: JSON.stringify(json);
};

const waitFor = async (probe: () => Promise<boolean>, ms = 15_000) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await probe()) return true;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
};

export type JourneyTargets = { globalUrl: string; tenantUrl: (tenant: Tenant) => string };

// Runs every check, printing each; resolves with the number of failures.
export const journey = async ({ globalUrl, tenantUrl }: JourneyTargets, sessions: Record<UserName, Session>) => {
	let failures = 0;
	const expect = (label: string, ok: boolean, detail: string) => {
		if (!ok) failures++;
		console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}`);
	};
	const { alice, bob } = sessions;
	const [tenantA, tenantB] = tenants;
	const records = (tenant: Tenant) => `${tenantUrl(tenant)}/api/collections/policies/records`;
	const granted = (tenant: Tenant) =>
		waitFor(async () => (await rtdb(tenant, `access/members/${alice.uid}`, alice)).json !== null);

	console.log("-- global Worker: real Firebase ID tokens");
	const aliceTenants = await call(`${globalUrl}/api/tenants`, alice.token);
	expect(
		"alice's real token lists her tenants",
		tenantIds(aliceTenants.json) === "tenant-a,tenant-b",
		`${aliceTenants.status} ${tenantIds(aliceTenants.json)}`,
	);
	const bobTenants = await call(`${globalUrl}/api/tenants`, bob.token);
	expect(
		"bob's real token lists only tenant A",
		tenantIds(bobTenants.json) === "tenant-a",
		`${bobTenants.status} ${tenantIds(bobTenants.json)}`,
	);
	for (const [label, token] of [
		["a tampered signature", tampered(alice.token)],
		["an unsigned emulator-style token", unsignedToken(alice.uid)],
		["garbage", "not-a-token"],
	] as const) {
		const { status } = await call(`${globalUrl}/api/tenants`, token);
		expect(`${label} is refused`, status === 401, String(status));
	}

	console.log("-- tenant A: session, protected create, real RTDB signal");
	// Tenant B's signal before tenant A changes, to show A's write never reaches B.
	const sessionB = await call(`${tenantUrl(tenantB)}/api/realtime/session`, alice.token, "POST");
	expect("alice opens a session on tenant B", sessionB.status === 200, String(sessionB.status));
	const grantedB = await granted(tenantB);
	const revisionB = revisionOf((await rtdb(tenantB, "collections/policies", alice)).json);

	const session = await call(`${tenantUrl(tenantA)}/api/realtime/session`, alice.token, "POST");
	const connection = (session.json as { connection?: { databaseURL?: string } } | null)?.connection;
	expect(
		"alice opens a realtime session on the real database",
		session.status === 200 && connection?.databaseURL === databaseUrl(tenantA),
		`${session.status} ${connection?.databaseURL}`,
	);
	const grant = await granted(tenantA);
	expect("her grant is written to RTDB by the Worker's adapter", grant, grant ? "present" : "missing");
	const before = revisionOf((await rtdb(tenantA, "collections/policies", alice)).json);
	const number = `STG-${Date.now()}`;
	const created = await call(records(tenantA), alice.token, "POST", {
		number,
		holder: "Staging Check",
		status: "pending",
	});
	expect("alice (agent) creates a policy", created.status === 201, String(created.status));
	let after: unknown = null;
	const signalled = await waitFor(async () => {
		after = revisionOf((await rtdb(tenantA, "collections/policies", alice)).json);
		return typeof after === "number" && (typeof before !== "number" || after > before);
	});
	expect("a newer policies revision reaches RTDB", signalled, `${String(before)} → ${String(after)}`);
	const list = await call(records(tenantA), alice.token);
	expect(
		"the authorized refetch returns the new policy",
		list.status === 200 && JSON.stringify(list.json).includes(number),
		String(list.status),
	);

	console.log("-- negative auth and tenant isolation");
	const bobCreate = await call(records(tenantA), bob.token, "POST", {
		number: `${number}-B`,
		holder: "Bob Member",
		status: "pending",
	});
	expect("bob (member) cannot create", bobCreate.status === 403, String(bobCreate.status));
	const bobOnB = await call(records(tenantB), bob.token);
	expect("bob is refused by tenant B", bobOnB.status === 403, String(bobOnB.status));
	const anonymous = await call(`${tenantUrl(tenantA)}/api/realtime/session`, null, "POST");
	expect("an anonymous session is refused", anonymous.status === 401, String(anonymous.status));
	const nowB = revisionOf((await rtdb(tenantB, "collections/policies", alice)).json);
	expect(
		"tenant A's create did not signal tenant B",
		grantedB && nowB === revisionB,
		`${String(revisionB)} → ${String(nowB)}`,
	);
	const listB = await call(records(tenantB), alice.token);
	expect(
		"tenant B's API does not return tenant A's policy",
		listB.status === 200 && !JSON.stringify(listB.json).includes(number),
		String(listB.status),
	);
	return failures;
};
