import { exports } from "cloudflare:workers";
import type { ErrorEnvelope } from "@takebase/contracts";
import { describe, expect, it } from "vitest";
import { authorizedRoutes, countPolicies, json, lockedRoutes, newPolicy } from "./fixtures.ts";

const missing = "00000000-0000-4000-8000-000000000000";
const operations = (collection: string) => {
	const base = `https://tenant.local/api/collections/${collection}/records`;
	return [
		["list", base, { method: "GET" }],
		["view", `${base}/${missing}`, { method: "GET" }],
		["create", base, json("POST", newPolicy())],
		["update", `${base}/${missing}`, json("PATCH", { status: "active" })],
		["delete", `${base}/${missing}`, { method: "DELETE" }],
	] as const;
};

const errorCode = async (response: Response) => ((await response.json()) as ErrorEnvelope).error.code;

describe("default deny", () => {
	it("the deployed tenant Worker resolves no identity and denies every operation", async () => {
		const before = await countPolicies();
		for (const [operation, url, init] of operations("policies")) {
			const response = await exports.default.fetch(url, init);
			expect(response.status, operation).toBe(401);
			expect(await errorCode(response)).toBe("unauthenticated");
		}
		expect(await countPolicies()).toBe(before);
	});

	it("a collection without rules denies every operation even to an identified caller", async () => {
		const routes = lockedRoutes();
		const before = await countPolicies();
		for (const [operation, url, init] of operations("locked_policies")) {
			const response = await routes.request(url, init);
			expect(response.status, operation).toBe(403);
			expect(await errorCode(response)).toBe("forbidden");
		}
		expect(await countPolicies()).toBe(before);
	});

	it("denies before reading input, so invalid bodies are not validated", async () => {
		const response = await lockedRoutes().request(
			"https://tenant.local/api/collections/locked_policies/records",
			json("POST", "{not json"),
		);
		expect(response.status).toBe(403);
	});

	it("the authorized fixture is not reachable through the deployed Worker", async () => {
		const created = await authorizedRoutes().request(
			"https://tenant.local/api/collections/policies/records",
			json("POST", newPolicy()),
		);
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		const response = await exports.default.fetch(`https://tenant.local/api/collections/policies/records/${id}`);
		expect(response.status).toBe(401);
	});
});
