import { describe, expect, it } from "vitest";
import { createRequestStore } from "../src/index.ts";

type Locals = { userId: string };

describe("createRequestStore", () => {
	it("exposes the context only inside runInRequest", () => {
		const store = createRequestStore<{ requestId: string }, Locals>();
		expect(() => store.useContext()).toThrow(/No request scope/);
		expect(store.runInRequest({ requestId: "r1" }, () => store.useContext().requestId)).toBe("r1");
		expect(() => store.requestLocals.get("userId")).toThrow(/No request scope/);
	});

	it("keeps locals isolated between concurrent requests", async () => {
		const store = createRequestStore<{ requestId: string }, Locals>();
		const handle = (requestId: string, delay: number) =>
			store.runInRequest({ requestId }, async () => {
				store.requestLocals.set("userId", `user-${requestId}`);
				await new Promise((resolve) => setTimeout(resolve, delay));
				return [store.useContext().requestId, store.requestLocals.get("userId")];
			});

		const results = await Promise.all([handle("a", 20), handle("b", 0)]);
		expect(results).toEqual([
			["a", "user-a"],
			["b", "user-b"],
		]);
	});
});
