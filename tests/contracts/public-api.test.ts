import { readdirSync, readFileSync } from "node:fs";
import type { CollectionRecord, ErrorEnvelope, ListEnvelope, ListQuery, UpdateInput } from "@takebase/contracts";
import * as contracts from "@takebase/contracts";
import * as sdk from "@takebase/sdk";
import { readResponse, TakebaseError } from "@takebase/sdk";
import { describe, expect, expectTypeOf, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const sourceFiles = (dir: string) =>
	readdirSync(new URL(`../../${dir}`, import.meta.url), { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".ts"))
		.map((file) => `${dir}/${file}`);

// Server-only modules a consumer of contracts or the SDK must never pull in.
const serverOnly =
	/from\s+["'](drizzle-orm|drizzle-kit|wrangler|hono|cloudflare:[\w-]+|@cloudflare\/[\w-]+|@takebase\/core|node:[\w/]+)["']/;

describe("@takebase/contracts public API", () => {
	it("exports only the documented runtime values", () => {
		expect(Object.keys(contracts).sort()).toEqual([
			"collectionOperations",
			"errorCodes",
			"errorStatus",
			"filterOperators",
			"isErrorCode",
			"isErrorEnvelope",
			"isListEnvelope",
			"maxPerPage",
			"toListSearchParams",
		]);
		expect(contracts.collectionOperations).toEqual(["list", "view", "create", "update", "delete"]);
		expect(contracts.filterOperators).toEqual(["eq", "ne", "gt", "gte", "lt", "lte", "in", "null"]);
		expect(contracts.maxPerPage).toBe(100);
	});

	it("serializes list queries to the filter[field][operator] query string", () => {
		type Fields = { status: "pending" | "active"; premium: number | null };
		const query: ListQuery<Fields> = {
			page: 2,
			perPage: 20,
			sort: "-created",
			filter: { status: "active", premium: { gt: 0, in: [1, 2] }, id: null },
		};
		expect(contracts.toListSearchParams(query).toString()).toBe(
			"page=2&perPage=20&sort=-created&filter%5Bstatus%5D=active&filter%5Bpremium%5D%5Bgt%5D=0&filter%5Bpremium%5D%5Bin%5D=1%2C2&filter%5Bid%5D%5Bnull%5D=true",
		);
		expect(contracts.toListSearchParams().toString()).toBe("");
	});

	it("maps every error code to an HTTP error status", () => {
		for (const code of contracts.errorCodes) expect(contracts.errorStatus[code]).toBeGreaterThanOrEqual(400);
	});

	it("recognises error and list envelopes", () => {
		const error: ErrorEnvelope = {
			error: { code: "validation_failed", message: "Invalid", fields: { number: "Required" } },
		};
		expect(contracts.isErrorEnvelope(error)).toBe(true);
		expect(contracts.isErrorEnvelope({ error: { code: "teapot", message: "x" } })).toBe(false);
		expect(contracts.isErrorEnvelope({ message: "x" })).toBe(false);

		const list: ListEnvelope<{ id: string }> = {
			items: [{ id: "1" }],
			page: 1,
			perPage: 20,
			totalItems: 1,
			totalPages: 1,
		};
		expect(contracts.isListEnvelope(list)).toBe(true);
		expect(contracts.isListEnvelope({ ...list, page: -1 })).toBe(false);
		expect(contracts.isListEnvelope({ items: {} })).toBe(false);
	});

	it("types records with server-owned fields", () => {
		type Policy = CollectionRecord<{ number: string; status: "pending" | "active" }>;
		expectTypeOf<Policy["id"]>().toEqualTypeOf<string>();
		expectTypeOf<UpdateInput<{ status: "pending" | "active" }>>().toEqualTypeOf<{ status?: "pending" | "active" }>();
	});
});

describe("@takebase/sdk public API", () => {
	it("exports the client factory, error type and response reader", () => {
		expect(Object.keys(sdk).sort()).toEqual(["TakebaseError", "createClient", "readResponse"]);
	});

	it("returns successful JSON bodies", async () => {
		await expect(readResponse<{ ok: boolean }>(Response.json({ ok: true }))).resolves.toEqual({ ok: true });
	});

	it("maps error envelopes to TakebaseError", async () => {
		const response = Response.json({ error: { code: "forbidden", message: "Not a member" } }, { status: 403 });
		const error = await readResponse(response).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TakebaseError);
		expect(error).toMatchObject({ status: 403, code: "forbidden", message: "Not a member", fields: {} });
	});

	it("maps responses without an envelope to a generic error", async () => {
		await expect(readResponse(new Response("oops", { status: 502 }))).rejects.toMatchObject({ code: "internal" });
		await expect(readResponse(new Response("oops", { status: 404 }))).rejects.toMatchObject({ code: "bad_request" });
		await expect(readResponse(new Response("not json"))).rejects.toMatchObject({ code: "invalid_response" });
	});
});

describe("consumer packages stay free of server code and secrets", () => {
	for (const dir of ["packages/contracts/src", "packages/sdk/src"]) {
		it(`${dir} imports no server-only modules`, () => {
			for (const file of sourceFiles(dir)) expect(read(file), file).not.toMatch(serverOnly);
		});

		it(`${dir} references no Worker secrets or bindings`, () => {
			for (const file of sourceFiles(dir))
				expect(read(file), file).not.toMatch(/DATA_KEY|D1Database|KVNamespace|env\.\w+/);
		});
	}
});
