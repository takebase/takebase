import {
	type AnyD1Database,
	AuthError,
	type AuthIdentity,
	authenticateTenantMember,
	createCollectionRoutes,
	createRequestStore,
	type MembershipCheck,
	type MembershipVerifier,
} from "@takebase/core";
import { Hono } from "hono";
import { collections } from "../src/collections/index.ts";

// S-7-2-01: one scenario, run unchanged on local D1 (portability.test.ts) and on
// isolated native SQLite (examples/native-spike). Both run the real migrations,
// the real policies collection and rules, and core's real guard and routes. Only
// the database differs, plus the stand-in for the global Worker below: neither
// runner verifies real tokens here. Nothing here may branch on the runtime; a
// difference is an incompatibility to write down, not to hide.

export type Migration = { name: string; queries: string[] };
export type Check = { name: string; ok: boolean; detail: string };
type Row = Record<string, unknown>;

const identities: Record<string, AuthIdentity> = {
	agent: { id: "agent", provider: "firebase", roles: ["member", "agent"] },
	member: { id: "member", provider: "firebase", roles: ["member"] },
};
const verifier: MembershipVerifier = {
	verifyMembership: async (token): Promise<MembershipCheck> => {
		const identity = identities[token];
		if (identity) return { status: "member", identity, revision: 1 };
		if (token === "outsider") return { status: "not_member", subject: "outsider", revision: 1 };
		return { status: "invalid_token" };
	},
};

type Scope = { db: AnyD1Database };
type Locals = { auth: AuthIdentity | null };
const { runInRequest, useContext, requestLocals } = createRequestStore<Scope, Locals>();

export const contractApp = (db: AnyD1Database) => {
	const app = new Hono();
	app.use("*", (c, next) =>
		runInRequest({ db }, async () => {
			try {
				const member = await authenticateTenantMember(verifier, "contract", c.req.header("authorization"));
				requestLocals.set("auth", member?.identity ?? null);
			} catch (error) {
				if (!(error instanceof AuthError)) throw error;
				return c.json({ error: { code: error.code, message: error.message } }, error.status);
			}
			await next();
		}),
	);
	app.route(
		"/",
		createCollectionRoutes({
			registry: collections,
			resolve: () => ({ db: useContext().db, auth: requestLocals.get("auth") ?? null, now: new Date() }),
		}),
	);
	return app;
};

const records = "https://tenant.local/api/collections/policies/records";
const unknownId = "00000000-0000-4000-8000-000000000000";

// Migrations go one at a time with a record written in between, so the run also
// proves an existing database upgrades on this engine.
export const runCollectionContract = async (db: AnyD1Database, migrations: Migration[]): Promise<Check[]> => {
	const checks: Check[] = [];
	const check = (name: string, ok: boolean, detail: unknown = "") =>
		checks.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
	const expectStatus = (name: string, actual: number, expected: number) =>
		check(name, actual === expected, `HTTP ${actual}, expected ${expected}`);
	const rows = async (sql: string, ...values: unknown[]) =>
		(
			await db
				.prepare(sql)
				.bind(...values)
				.all<Row>()
		).results;
	const total = async (sql: string, ...values: unknown[]) => Number((await rows(sql, ...values))[0]?.total ?? -1);
	const apply = async ({ queries }: Migration) => {
		await db.batch(queries.map((query) => db.prepare(query)));
	};

	const app = contractApp(db);
	const call = async (url: string, token: string | null, method = "GET", body?: unknown) =>
		app.request(url, {
			method,
			headers: {
				...(token === null ? {} : { authorization: `Bearer ${token}` }),
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const newPolicy = (number: string, extra: Row = {}) => ({
		number,
		holder: "Contract Holder",
		status: "active",
		...extra,
	});

	// Migrations, with a record from before the last ones.
	const [first, ...rest] = migrations;
	if (first === undefined) throw new Error("No migrations to apply");
	await apply(first);
	const old = "11111111-1111-4111-8111-111111111111";
	const stamp = "2026-10-01T00:00:00.000Z";
	await db
		.prepare(
			"insert into policies (id, number, holder, status, premium, created, updated) values (?, 'OLD-1', 'Old Holder', 'active', 5, ?, ?)",
		)
		.bind(old, stamp, stamp)
		.run();
	for (const migration of rest) await apply(migration);
	const objects = await rows(
		"select name from sqlite_master where type in ('table', 'index') and name in ('policies', 'agents', 'takebase_outbox', 'policies_number_unique', 'takebase_outbox_id_unique', 'takebase_outbox_claimable') order by name",
	);
	check("migrations create the same objects", objects.length === 6, objects);
	const upgraded = await call(`${records}/${old}`, "member");
	expectStatus("a record from before the upgrade is readable through the API", upgraded.status, 200);

	// Authentication and rules.
	expectStatus("an invalid token is refused", (await call(records, "not-a-token")).status, 401);
	expectStatus("a non-member is refused", (await call(records, "outsider")).status, 403);
	expectStatus("anonymous cannot list", (await call(records, null)).status, 401);
	const denied = await call(records, "member", "POST", newPolicy("DENIED-1"));
	expectStatus("a member cannot create (agents only)", denied.status, 403);
	check(
		"a refused create writes nothing",
		(await total("select count(*) as total from policies where number = 'DENIED-1'")) === 0,
	);

	// Create, with its outbox event in the same transaction.
	const created = await call(records, "agent", "POST", newPolicy("NEW-1", { premium: 100 }));
	expectStatus("an agent creates a policy", created.status, 201);
	const record = (await created.json()) as { id: string; number: string; created: string; updated: string };
	check(
		"the created record has id and timestamps",
		/^[0-9a-f-]{36}$/.test(record.id) && record.created === record.updated,
	);
	check(
		"the create wrote one outbox event",
		(await total(
			"select count(*) as total from takebase_outbox where record_id = ? and operation = 'create'",
			record.id,
		)) === 1,
	);

	// Validation, unique and exists rules.
	const invalid = await call(records, "agent", "POST", { number: "BAD-1", holder: "x", status: "nope" });
	const invalidBody = (await invalid.json()) as { error?: { fields?: Row } };
	expectStatus("invalid input is refused", invalid.status, 422);
	check(
		"invalid input names each field",
		Object.keys(invalidBody.error?.fields ?? {})
			.sort()
			.join() === "holder,status",
	);
	expectStatus(
		"the unique rule refuses a repeated number",
		(await call(records, "agent", "POST", newPolicy("NEW-1"))).status,
		422,
	);
	expectStatus(
		"the exists rule refuses an unknown agent",
		(await call(records, "agent", "POST", newPolicy("NEW-2", { agent_id: "nobody" }))).status,
		422,
	);

	// View, update, delete.
	expectStatus("a member views the record", (await call(`${records}/${record.id}`, "member")).status, 200);
	expectStatus("an unknown record is not found", (await call(`${records}/${unknownId}`, "member")).status, 404);
	const updated = await call(`${records}/${record.id}`, "member", "PATCH", { status: "cancelled" });
	expectStatus("a member updates the record", updated.status, 200);
	check("the update is stored", ((await updated.json()) as { status?: string }).status === "cancelled");
	check(
		"the update wrote one outbox event",
		(await total(
			"select count(*) as total from takebase_outbox where record_id = ? and operation = 'update'",
			record.id,
		)) === 1,
	);
	const before = await total("select count(*) as total from takebase_outbox");
	expectStatus(
		"updating an unknown record is not found",
		(await call(`${records}/${unknownId}`, "member", "PATCH", { status: "active" })).status,
		404,
	);
	check(
		"updating an unknown record writes no event",
		(await total("select count(*) as total from takebase_outbox")) === before,
	);
	expectStatus("delete is denied by the rules", (await call(`${records}/${record.id}`, "agent", "DELETE")).status, 403);
	check(
		"a denied delete keeps the record",
		(await total("select count(*) as total from policies where id = ?", record.id)) === 1,
	);

	// Lists.
	for (const index of [1, 2, 3])
		await call(records, "agent", "POST", newPolicy(`LIST-${index}`, { premium: index * 1000 }));
	const list = await call(`${records}?filter[premium][gte]=1000&sort=-premium&perPage=2&page=1`, "member");
	const page = (await list.json()) as { items: { number: string }[]; totalItems: number; totalPages: number };
	expectStatus("a filtered, sorted list answers", list.status, 200);
	check(
		"the list filters, sorts and counts",
		page.items.map(({ number }) => number).join() === "LIST-3,LIST-2" && page.totalItems === 3 && page.totalPages === 2,
		page,
	);
	expectStatus("an undeclared filter is refused", (await call(`${records}?filter[holder]=x`, "member")).status, 400);

	// What the engine itself enforces.
	const refused = async (sql: string) => {
		try {
			await db.prepare(sql).run();
			return false;
		} catch {
			return true;
		}
	};
	check(
		"the database enforces foreign keys",
		await refused(
			`insert into policies (id, number, holder, status, agent_id, created, updated) values ('fk', 'FK-1', 'Holder', 'active', 'nobody', '${stamp}', '${stamp}')`,
		),
	);
	check(
		"the database enforces the unique index",
		await refused(
			`insert into policies (id, number, holder, status, created, updated) values ('dup', 'NEW-1', 'Holder', 'active', '${stamp}', '${stamp}')`,
		),
	);

	// A write and its event commit together or not at all.
	await db
		.prepare(
			"create trigger contract_fail_outbox before insert on takebase_outbox begin select raise(abort, 'forced outbox failure'); end",
		)
		.run();
	const atomic = await call(records, "agent", "POST", newPolicy("ATOMIC-1"));
	await db.prepare("drop trigger contract_fail_outbox").run();
	// A known difference: D1 reports the abort as SQLITE_CONSTRAINT, so core answers
	// 409; Bun words it otherwise, so core answers 500. Both refuse and roll back.
	check("a failed event fails the write", atomic.status >= 400, `HTTP ${atomic.status}`);
	check(
		"a failed event leaves no record",
		(await total("select count(*) as total from policies where number = 'ATOMIC-1'")) === 0,
	);

	// Overlapping requests keep their own identity.
	const overlapping = await Promise.all(
		Array.from({ length: 12 }, (_, index) =>
			call(records, index % 2 === 0 ? "member" : "outsider").then(({ status }) => status),
		),
	);
	check(
		"overlapping requests keep their own identity",
		overlapping.every((status, index) => status === (index % 2 === 0 ? 200 : 403)),
		overlapping,
	);
	return checks;
};
