import { env } from "cloudflare:workers";
import type { CollectionRecord } from "@takebase/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { authorizedRoutes, countPolicies, json, lockedRoutes, newPolicy, uncheckedRoutes } from "./fixtures.ts";

const base = "https://tenant.local/api/collections";

type OutboxRow = Record<string, unknown> & { record_id: string; operation: string; seq: number };

const eventsFor = async (recordId: string) =>
	(
		await env.DB.prepare("select * from takebase_outbox where record_id = ? order by seq")
			.bind(recordId)
			.all<OutboxRow>()
	).results;

const countEvents = async () =>
	(await env.DB.prepare("select count(*) as total from takebase_outbox").first<{ total: number }>())?.total ?? 0;

const createPolicy = async (overrides: Record<string, unknown> = {}) => {
	const response = await authorizedRoutes().request(`${base}/policies/records`, json("POST", newPolicy(overrides)));
	expect(response.status).toBe(201);
	return (await response.json()) as CollectionRecord;
};

// Makes every outbox insert fail inside D1, around the record statement.
// SQLite reports RAISE(ABORT) as a constraint error, so routes answer 409.
const failOutboxInserts = () =>
	env.DB.prepare(
		"create trigger fail_outbox before insert on takebase_outbox begin select raise(abort, 'forced outbox failure'); end",
	).run();

afterEach(async () => {
	await env.DB.prepare("drop trigger if exists fail_outbox").run();
});

describe("R-4-1-01: record changes and outbox events commit together", () => {
	it("writes one minimal event per committed create, update and delete", async () => {
		const routes = authorizedRoutes();
		const record = await createPolicy({ notes: "private note" });
		expect(
			(await routes.request(`${base}/policies/records/${record.id}`, json("PATCH", { status: "active" }))).status,
		).toBe(200);
		expect((await routes.request(`${base}/policies/records/${record.id}`, json("DELETE"))).status).toBe(204);

		const events = await eventsFor(record.id);
		expect(events.map((event) => event.operation)).toEqual(["create", "update", "delete"]);
		expect(events[0]?.seq).toBeLessThan(events[1]?.seq ?? 0);
		expect(events[1]?.seq).toBeLessThan(events[2]?.seq ?? 0);
		for (const event of events) {
			expect(event).toMatchObject({ collection: "policies", status: "pending", attempts: 0 });
			// Only invalidation metadata: no record field ever reaches the outbox.
			expect(JSON.stringify(event)).not.toMatch(/private note|Ada Lovelace|POL-/);
		}
		expect(new Set(events.map((event) => event.id)).size).toBe(3);
	});

	it("emits nothing for denied, invalid or missing-record writes", async () => {
		const before = await countEvents();
		expect((await lockedRoutes().request(`${base}/locked_policies/records`, json("POST", newPolicy()))).status).toBe(
			403,
		);
		const routes = authorizedRoutes();
		expect((await routes.request(`${base}/policies/records`, json("POST", { holder: "x" }))).status).toBe(422);
		const missing = crypto.randomUUID();
		expect(
			(await routes.request(`${base}/policies/records/${missing}`, json("PATCH", { status: "active" }))).status,
		).toBe(404);
		expect((await routes.request(`${base}/policies/records/${missing}`, json("DELETE"))).status).toBe(404);
		expect(await countEvents()).toBe(before);
	});
});

describe("S-4-1-01: a failure anywhere in the batch rolls back the whole unit", () => {
	it("a failing record insert leaves no event", async () => {
		const existing = await createPolicy();
		const before = { records: await countPolicies(), events: await countEvents() };
		// Bypasses the unique rule, so only the D1 unique index rejects the insert.
		const response = await uncheckedRoutes().request(
			`${base}/unchecked_policies/records`,
			json("POST", newPolicy({ number: existing.number })),
		);
		expect(response.status).toBe(409);
		expect({ records: await countPolicies(), events: await countEvents() }).toEqual(before);
	});

	it("a failing event insert rolls back the create, update and delete", async () => {
		const routes = authorizedRoutes();
		const record = await createPolicy();
		const before = { records: await countPolicies(), events: await countEvents() };
		await failOutboxInserts();

		expect((await routes.request(`${base}/policies/records`, json("POST", newPolicy()))).status).toBe(409);
		expect(
			(await routes.request(`${base}/policies/records/${record.id}`, json("PATCH", { status: "active" }))).status,
		).toBe(409);
		expect((await routes.request(`${base}/policies/records/${record.id}`, json("DELETE"))).status).toBe(409);

		expect({ records: await countPolicies(), events: await countEvents() }).toEqual(before);
		const stored = await env.DB.prepare("select status, updated from policies where id = ?").bind(record.id).first();
		expect(stored).toEqual({ status: record.status, updated: record.updated });
	});
});
