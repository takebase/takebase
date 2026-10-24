import { describe, expect, it } from "vitest";
import { type Fetch, TakebaseError } from "../src/index.ts";
import { tenantCollection } from "./helpers.ts";

const policies = (fetch: Fetch) => tenantCollection(fetch);
const answer =
	(response: Response): Fetch =>
	async () =>
		response;
const failure = async (promise: Promise<unknown>) => {
	const error = await promise.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(TakebaseError);
	return error as TakebaseError;
};

describe("errors", () => {
	it("maps error envelopes, including field errors, to TakebaseError", async () => {
		const body = { error: { code: "validation_failed", message: "Invalid", fields: { number: "Required" } } };
		const error = await failure(policies(answer(Response.json(body, { status: 422 }))).create({}));
		expect(error).toMatchObject({
			status: 422,
			code: "validation_failed",
			message: "Invalid",
			fields: { number: "Required" },
		});

		const denied = await failure(
			policies(answer(Response.json({ error: { code: "unauthenticated", message: "No" } }, { status: 401 }))).getList(),
		);
		expect(denied).toMatchObject({ status: 401, code: "unauthenticated", fields: {} });
	});

	it("fails safely on non-JSON and malformed responses", async () => {
		const html = () => new Response("<html>Bad gateway</html>", { status: 502 });
		expect(await failure(policies(answer(html())).getList())).toMatchObject({ status: 502, code: "internal" });
		expect(await failure(policies(answer(new Response("not json"))).view("x"))).toMatchObject({
			status: 200,
			code: "invalid_response",
		});

		const malformed: unknown[] = [
			{ items: "nope" },
			{ items: [], page: 1, perPage: 20, totalItems: -1, totalPages: 0 },
			{ items: [{ id: 1 }], page: 1, perPage: 20, totalItems: 1, totalPages: 1 },
			[],
			null,
		];
		for (const body of malformed)
			expect(await failure(policies(answer(Response.json(body))).getList()), JSON.stringify(body)).toMatchObject({
				code: "invalid_response",
			});
		for (const body of [{ id: "x" }, [], "record", null])
			expect(await failure(policies(answer(Response.json(body))).view("x"))).toMatchObject({
				code: "invalid_response",
			});

		const teapot = { error: { code: "teapot", message: "x" } };
		expect(await failure(policies(answer(Response.json(teapot, { status: 418 }))).delete("x"))).toMatchObject({
			status: 418,
			code: "bad_request",
		});
	});

	it("reports network failures with status 0 and keeps the cause", async () => {
		const cause = new TypeError("fetch failed");
		const error = await failure(
			policies(async () => {
				throw cause;
			}).getList(),
		);
		expect(error).toMatchObject({ status: 0, code: "network" });
		expect(error.cause).toBe(cause);
	});

	it("reports aborted requests", async () => {
		const controller = new AbortController();
		const fetch: Fetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
			});
		const pending = policies(fetch).getList({}, { signal: controller.signal });
		controller.abort();
		expect(await failure(pending)).toMatchObject({ status: 0, code: "aborted" });

		const timeout: Fetch = async () => {
			throw new DOMException("Timed out", "AbortError");
		};
		expect(await failure(policies(timeout).view("x"))).toMatchObject({ code: "aborted" });
	});
});
