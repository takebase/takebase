import { createClient, EMULATOR_URL, FirebaseRtdbError } from "@takebase/firebase-rtdb";
import { describe, expect, it } from "vitest";

// @takebase/firebase-rtdb runs inside workerd: fetch, Web Streams and
// AbortSignal only. The database is a scripted fetch; no network is used.
describe("@takebase/firebase-rtdb in the Workers runtime", () => {
	it("reads with an ETag and writes conditionally", async () => {
		const answers = [
			new Response(JSON.stringify({ revision: 1 }), { headers: { ETag: "etag-1" } }),
			new Response(JSON.stringify({ revision: 2 })),
			new Response(JSON.stringify({ error: "ETag mismatch" }), { status: 412 }),
		];
		const client = createClient({
			databaseURL: EMULATOR_URL,
			fetch: async () => answers.shift() ?? new Response(null, { status: 500 }),
		});
		const { value, etag } = await client.getWithETag("collections/policies");
		expect([value, etag]).toEqual([{ revision: 1 }, "etag-1"]);
		await client.setIfUnchanged("collections/policies", { revision: 2 }, etag);
		const conflict = await client.setIfUnchanged("collections/policies", { revision: 2 }, etag).catch((e) => e);
		expect(conflict).toBeInstanceOf(FirebaseRtdbError);
		expect(conflict.code).toBe("conflict");
	});
});
