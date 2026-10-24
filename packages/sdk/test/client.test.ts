import { describe, expect, expectTypeOf, it } from "vitest";
import type { CollectionRecord, Fetch, ListEnvelope } from "../src/index.ts";
import { tenantClient, tenantCollection } from "./helpers.ts";

type PolicyFields = { number: string; status: "pending" | "active"; premium: number | null };
type Policy = CollectionRecord<PolicyFields>;

const policy: Policy = {
	id: "8c0e6f6a-3b9e-4c1a-9f3e-2a1d4b5c6d7e",
	number: "ABC123",
	status: "pending",
	premium: null,
	created: "2026-10-23T10:00:00.000Z",
	updated: "2026-10-23T10:00:00.000Z",
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

// A fetch that records each call and answers with the next queued response.
const recordingFetch = (...responses: Response[]) => {
	const calls: Call[] = [];
	const fetch: Fetch = async (url, init) => {
		calls.push({
			url,
			method: init.method ?? "GET",
			headers: init.headers as Record<string, string>,
			body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
		});
		const response = responses.shift();
		if (!response) throw new Error("No response queued");
		return response;
	};
	return { calls, fetch };
};

const policies = (fetch: Fetch) => tenantCollection<PolicyFields>(fetch);

describe("collection CRUD", () => {
	it("creates, views, updates and deletes records over the REST routes", async () => {
		const active = { ...policy, status: "active" as const };
		const { calls, fetch } = recordingFetch(
			Response.json(policy, { status: 201 }),
			Response.json(policy),
			Response.json(active),
			new Response(null, { status: 204 }),
		);
		const client = policies(fetch);

		expect(await client.create({ number: "ABC123", status: "pending", premium: null })).toEqual(policy);
		expect(await client.view(policy.id)).toEqual(policy);
		expect(await client.update(policy.id, { status: "active" })).toEqual(active);
		await expect(client.delete(policy.id)).resolves.toBeUndefined();

		const base = "https://tenant.example/api/collections/policies/records";
		expect(calls.map(({ method, url }) => [method, url])).toEqual([
			["POST", base],
			["GET", `${base}/${policy.id}`],
			["PATCH", `${base}/${policy.id}`],
			["DELETE", `${base}/${policy.id}`],
		]);
		expect(calls[0]?.body).toEqual({ number: "ABC123", status: "pending", premium: null });
		expect(calls[0]?.headers).toEqual({
			accept: "application/json",
			"content-type": "application/json",
			authorization: "Bearer user-1-token-0",
		});
		expect(calls[1]?.headers).toEqual({ accept: "application/json", authorization: "Bearer user-1-token-0" });
		expect(calls[2]?.body).toEqual({ status: "active" });
	});

	it("serializes list queries into allowlist-checked parameters", async () => {
		const page: ListEnvelope<Policy> = { items: [policy], page: 1, perPage: 20, totalItems: 1, totalPages: 1 };
		const { calls, fetch } = recordingFetch(Response.json(page), Response.json(page));
		const client = policies(fetch);

		expect(
			await client.getList({
				page: 1,
				perPage: 20,
				sort: ["-premium", "number"],
				filter: { status: { in: ["pending", "active"] }, premium: { gte: 100, null: false }, number: "ABC123" },
			}),
		).toEqual(page);
		await client.getList();

		const url = new URL(calls[0]?.url ?? "");
		expect(url.pathname).toBe("/api/collections/policies/records");
		expect([...url.searchParams]).toEqual([
			["page", "1"],
			["perPage", "20"],
			["sort", "-premium,number"],
			["filter[status][in]", "pending,active"],
			["filter[premium][gte]", "100"],
			["filter[premium][null]", "false"],
			["filter[number]", "ABC123"],
		]);
		expect(calls[1]?.url).toBe("https://tenant.example/api/collections/policies/records");
	});

	it("encodes record ids and refuses invalid collection names", async () => {
		const { calls, fetch } = recordingFetch(Response.json(policy));
		await policies(fetch).view("a/../../b?c");
		expect(calls[0]?.url).toBe("https://tenant.example/api/collections/policies/records/a%2F..%2F..%2Fb%3Fc");
		const client = await tenantClient(fetch);
		for (const name of ["", "Policies", "policies/../x", "sqlite master"])
			expect(() => client.collection(name), name).toThrow(TypeError);
	});

	it("types records, inputs, filters and sorts from the collection fields", () => {
		const client = policies(recordingFetch().fetch);
		expectTypeOf(client.view).returns.resolves.toEqualTypeOf<Policy>();
		expectTypeOf(client.update).parameter(1).toEqualTypeOf<Partial<PolicyFields>>();
		expectTypeOf(client.getList).toBeCallableWith({ filter: { premium: null, id: "x" }, sort: ["-created"] });
		// Compile-time only: never called.
		const _invalid = () => [
			// @ts-expect-error unknown field
			client.getList({ filter: { holder: "x" } }),
			// @ts-expect-error value of the wrong type
			client.getList({ filter: { premium: "high" } }),
			// @ts-expect-error unknown sort field
			client.getList({ sort: "-holder" }),
		];
		expect(_invalid).toBeTypeOf("function");
	});
});
