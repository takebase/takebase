import { env } from "cloudflare:workers";
import type { CollectionRecord, ErrorEnvelope, ListEnvelope } from "@takebase/contracts";
import { describe, expect, it } from "vitest";
import { addAgent, authorizedRoutes, countPolicies, json, newPolicy, uncheckedRoutes } from "./fixtures.ts";

const base = "https://tenant.local/api/collections/policies/records";
type Policy = CollectionRecord<{ number: string; holder: string; status: string; premium: number | null }>;

describe("policies collection CRUD on tenant D1 (authorized fixture)", () => {
	it("creates, views, lists, updates and deletes a record", async () => {
		let clock = new Date("2026-10-23T10:00:00.000Z");
		const routes = authorizedRoutes(() => clock);
		const input = newPolicy({ premium: 1200 });

		const created = await routes.request(base, json("POST", input));
		expect(created.status).toBe(201);
		const record = (await created.json()) as Policy;
		expect(record).toMatchObject({ ...input, notes: null, created: clock.toISOString(), updated: clock.toISOString() });
		expect(record.id).toMatch(/^[0-9a-f-]{36}$/);

		const viewed = await routes.request(`${base}/${record.id}`);
		expect(viewed.status).toBe(200);
		expect(await viewed.json()).toEqual(record);

		const listed = (await (await routes.request(`${base}?perPage=100`)).json()) as ListEnvelope<Policy>;
		expect(listed.items.map((item) => item.id)).toContain(record.id);
		expect(listed).toMatchObject({ page: 1, perPage: 100 });

		clock = new Date("2026-10-23T11:00:00.000Z");
		const updated = await routes.request(`${base}/${record.id}`, json("PATCH", { status: "active" }));
		expect(updated.status).toBe(200);
		expect(await updated.json()).toEqual({ ...record, status: "active", updated: clock.toISOString() });

		const deleted = await routes.request(`${base}/${record.id}`, { method: "DELETE" });
		expect(deleted.status).toBe(204);
		expect((await routes.request(`${base}/${record.id}`)).status).toBe(404);
		expect((await routes.request(`${base}/${record.id}`, { method: "DELETE" })).status).toBe(404);
	});

	it("writes only to its own tenant database", async () => {
		const before = await countPolicies();
		await authorizedRoutes().request(base, json("POST", newPolicy()));
		expect(await countPolicies()).toBe(before + 1);
		expect(await countPolicies(env.OTHER_TENANT_DB)).toBe(0);
	});

	it("returns field errors and stores nothing for invalid input", async () => {
		const routes = authorizedRoutes();
		const before = await countPolicies();
		const response = await routes.request(
			base,
			json("POST", { number: "P-1", status: "deleted", id: "forced-id", "holder) values (1); --": "x" }),
		);
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: {
				code: "validation_failed",
				message: "The given data was invalid.",
				fields: {
					holder: "The holder field is required.",
					status: "The selected status is invalid.",
					id: "The id field is prohibited.",
					"holder) values (1); --": "The holder) values (1); -- field is prohibited.",
				},
			},
		});
		expect(await countPolicies()).toBe(before);
	});

	it("rejects malformed bodies and query parameters with stable errors", async () => {
		const routes = authorizedRoutes();
		const code = async (response: Response) => [response.status, ((await response.json()) as ErrorEnvelope).error.code];
		expect(await code(await routes.request(base, json("POST", "{not json")))).toEqual([400, "bad_request"]);
		expect(await code(await routes.request(base, json("POST", [newPolicy()])))).toEqual([400, "bad_request"]);
		expect(await code(await routes.request(`${base}?perPage=0`))).toEqual([400, "bad_request"]);
		expect(await code(await routes.request(`${base}?perPage=101`))).toEqual([400, "bad_request"]);
		expect(await code(await routes.request(`${base}?page=1.5`))).toEqual([400, "bad_request"]);
		expect(await code(await routes.request(`${base}?filter=status='active'`))).toEqual([400, "bad_request"]);
	});

	it("returns not found for unknown collections and missing or malformed record ids", async () => {
		const routes = authorizedRoutes();
		const missing = "00000000-0000-4000-8000-000000000000";
		for (const path of [
			"https://tenant.local/api/collections/posts/records",
			"https://tenant.local/api/collections/sqlite_master/records",
			`https://tenant.local/api/collections/${encodeURIComponent("policies; drop table policies")}/records`,
			`${base}/${missing}`,
			`${base}/${encodeURIComponent("1 or 1=1")}`,
		]) {
			const response = await routes.request(path);
			expect(response.status, path).toBe(404);
			expect(((await response.json()) as ErrorEnvelope).error.code).toBe("not_found");
		}
		expect((await routes.request(`${base}/${missing}`, json("PATCH", { status: "active" }))).status).toBe(404);
	});

	it("rejects a taken number like Laravel's unique rule, ignoring the record being updated", async () => {
		const routes = authorizedRoutes();
		const first = (await (await routes.request(base, json("POST", newPolicy()))).json()) as Policy;
		const second = (await (await routes.request(base, json("POST", newPolicy()))).json()) as Policy;
		const before = await countPolicies();

		const duplicate = await routes.request(base, json("POST", newPolicy({ number: first.number })));
		expect(duplicate.status).toBe(422);
		expect(((await duplicate.json()) as ErrorEnvelope).error.fields).toEqual({
			number: "The number has already been taken.",
		});
		expect(await countPolicies()).toBe(before);

		const clash = await routes.request(`${base}/${second.id}`, json("PATCH", { number: first.number }));
		expect(clash.status).toBe(422);
		expect(await (await routes.request(`${base}/${second.id}`)).json()).toEqual(second);

		const same = await routes.request(`${base}/${first.id}`, json("PATCH", { number: first.number, holder: "Grace" }));
		expect(same.status).toBe(200);
		expect(await same.json()).toMatchObject({ number: first.number, holder: "Grace" });
	});

	it("requires a referenced agent to exist like Laravel's exists rule", async () => {
		const routes = authorizedRoutes();
		const agentId = await addAgent("agent-1");
		const missing = await routes.request(base, json("POST", newPolicy({ agent_id: "agent-404" })));
		expect(missing.status).toBe(422);
		expect(((await missing.json()) as ErrorEnvelope).error.fields).toEqual({
			agent_id: "The selected agent id is invalid.",
		});

		const created = await routes.request(base, json("POST", newPolicy({ agent_id: agentId })));
		expect(created.status).toBe(201);
		expect(await created.json()).toMatchObject({ agent_id: agentId });
		expect((await routes.request(base, json("POST", newPolicy({ agent_id: null })))).status).toBe(201);
	});

	it("still answers 409 from D1 constraints when a write skips those checks, leaving data unchanged", async () => {
		const routes = authorizedRoutes();
		const unchecked = uncheckedRoutes();
		const uncheckedBase = "https://tenant.local/api/collections/unchecked_policies/records";
		const first = (await (await routes.request(base, json("POST", newPolicy()))).json()) as Policy;
		const second = (await (await routes.request(base, json("POST", newPolicy()))).json()) as Policy;
		const before = await countPolicies();

		const conflict = { error: { code: "conflict", message: "The record conflicts with an existing record" } };
		const duplicate = await unchecked.request(uncheckedBase, json("POST", newPolicy({ number: first.number })));
		expect(duplicate.status).toBe(409);
		expect(await duplicate.json()).toEqual(conflict);
		const orphan = await unchecked.request(uncheckedBase, json("POST", newPolicy({ agent_id: "agent-404" })));
		expect(orphan.status).toBe(409);
		expect(await countPolicies()).toBe(before);

		const clash = await unchecked.request(`${uncheckedBase}/${second.id}`, json("PATCH", { number: first.number }));
		expect(clash.status).toBe(409);
		expect(await (await routes.request(`${base}/${second.id}`)).json()).toEqual(second);
	});

	it("pages through records newest first", async () => {
		let tick = Date.parse("2030-01-01T00:00:00.000Z");
		const routes = authorizedRoutes(() => {
			tick += 1000;
			return new Date(tick);
		});
		const ids: string[] = [];
		for (let i = 0; i < 3; i++)
			ids.push(((await (await routes.request(base, json("POST", newPolicy()))).json()) as Policy).id);

		const page = (await (await routes.request(`${base}?page=2&perPage=1`)).json()) as ListEnvelope<Policy>;
		expect(page.items.map((item) => item.id)).toEqual([ids[1]]);
		expect(page.totalPages).toBe(page.totalItems);
	});
});
