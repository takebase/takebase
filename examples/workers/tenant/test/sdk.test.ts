import { env, exports } from "cloudflare:workers";
import { createClient, type Fetch, type ListQuery, TakebaseError } from "@takebase/sdk";
import { describe, expect, it } from "vitest";
import { addAgent, authorizedRoutes, countPolicies, tenantMembership, testAuth } from "./fixtures.ts";

type PolicyFields = {
	number: string;
	holder: string;
	status: "pending" | "active" | "cancelled";
	agent_id?: string | null;
	premium?: number | null;
	notes?: string | null;
};

// The real SDK over the real tenant routes and D1: through the authorized
// fixture (explicit internal identity), or through the deployed Worker.
const fixtureFetch: Fetch = async (url, init) => authorizedRoutes().request(url, init);
const workerFetch: Fetch = (url, init) => exports.default.fetch(url, init);
// The SDK selects the tenant through discovery, answered here by a test-only
// global URL; signed in as the internal identity, or signed out for the Worker.
const policiesVia = async (fetch: Fetch, uid: string | null = "test-internal") => {
	const client = createClient({
		globalUrl: "https://global.local",
		auth: testAuth(uid),
		fetch: async (url, init) =>
			url === "https://global.local/api/tenants"
				? Response.json({ tenants: [tenantMembership("https://tenant.local")] })
				: fetch(url, init),
	});
	await client.useTenant(env.TENANT_ID);
	return client.collection<PolicyFields>("policies");
};

const failure = async (promise: Promise<unknown>) => {
	const error = await promise.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(TakebaseError);
	return error as TakebaseError;
};

describe("SDK → tenant Worker routes → D1 (S-2-2-01)", () => {
	it("creates ABC123/pending, updates it to active and reads a deterministic page 1 of 20", async () => {
		const policies = await policiesVia(fixtureFetch);
		const agentId = await addAgent(`sdk-${crypto.randomUUID()}`);

		const created = await policies.create({
			number: "ABC123",
			holder: "Ada Lovelace",
			status: "pending",
			agent_id: agentId,
		});
		expect(created).toMatchObject({ number: "ABC123", status: "pending", agent_id: agentId });
		const updated = await policies.update(created.id, { status: "active" });
		expect(updated).toMatchObject({ id: created.id, status: "active" });
		expect(await policies.view(created.id)).toEqual(updated);

		for (let i = 1; i <= 24; i++) {
			const number = `SDK-${String(i).padStart(2, "0")}`;
			await policies.create({ number, holder: "Grace Hopper", status: "pending", agent_id: agentId, premium: i * 10 });
		}

		const query: ListQuery<PolicyFields> = { filter: { agent_id: agentId }, sort: "number", page: 1, perPage: 20 };
		const page = await policies.getList(query);
		expect(page).toMatchObject({ page: 1, perPage: 20, totalItems: 25, totalPages: 2 });
		expect(page.items).toHaveLength(20);
		expect(page.items[0]).toEqual(updated);
		expect(page.items.slice(1).map((item) => item.number)).toEqual(
			Array.from({ length: 19 }, (_, i) => `SDK-${String(i + 1).padStart(2, "0")}`),
		);
		expect((await policies.getList(query)).items.map((item) => item.id)).toEqual(page.items.map((item) => item.id));

		const rest = await policies.getList({ ...query, page: 2 });
		expect(rest.items.map((item) => item.number)).toEqual(["SDK-20", "SDK-21", "SDK-22", "SDK-23", "SDK-24"]);

		const active = await policies.getList({ filter: { agent_id: agentId, status: "active" } });
		expect(active.items.map((item) => item.id)).toEqual([created.id]);
		const premiums = await policies.getList({
			filter: { agent_id: agentId, premium: { gte: 200, lt: 230 } },
			sort: ["-premium"],
		});
		expect(premiums.items.map((item) => item.premium)).toEqual([220, 210, 200]);

		await policies.delete(created.id);
		expect(await failure(policies.view(created.id))).toMatchObject({ status: 404, code: "not_found" });
	});

	it("surfaces validation, query and missing-record errors from the Worker", async () => {
		const policies = await policiesVia(fixtureFetch);
		const before = await countPolicies();

		const invalid = await failure(policies.create({ number: "", holder: "A", status: "deleted" as "pending" }));
		expect(invalid).toMatchObject({ status: 422, code: "validation_failed" });
		expect(Object.keys(invalid.fields).sort()).toEqual(["holder", "number", "status"]);

		const unsafe = [
			{ filter: { holder: "Ada" } },
			{ sort: "-notes" },
			{ perPage: 101 },
			{ filter: { premium: { gt: Number.NaN } } },
		] as ListQuery<PolicyFields>[];
		for (const query of unsafe)
			expect(await failure(policies.getList(query)), JSON.stringify(query)).toMatchObject({
				status: 400,
				code: "bad_request",
			});

		expect(await failure(policies.update("00000000-0000-4000-8000-000000000000", { status: "active" }))).toMatchObject({
			status: 404,
			code: "not_found",
		});
		expect(await countPolicies()).toBe(before);
	});

	it("is denied by the deployed Worker for a signed-out user", async () => {
		const policies = await policiesVia(workerFetch, null);
		const before = await countPolicies();
		for (const attempt of [
			() => policies.getList(),
			() => policies.view("00000000-0000-4000-8000-000000000000"),
			() => policies.create({ number: "DENIED-1", holder: "Ada Lovelace", status: "pending" }),
		])
			expect(await failure(attempt())).toMatchObject({ status: 401, code: "unauthenticated" });
		expect(await countPolicies()).toBe(before);
	});
});
