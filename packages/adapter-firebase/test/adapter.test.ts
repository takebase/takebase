import { createClient, EMULATOR_URL } from "@takebase/firebase-rtdb";
import { describe, expect, it } from "vitest";
import { createFirebaseRealtime, databaseRules } from "../src/index.ts";

type Call = { method: string; path: string; body: unknown };

// A database stand-in answering each request with the next scripted response.
const scripted = (...answers: Response[]) => {
	const calls: Call[] = [];
	const fetch = async (input: string, init: RequestInit) => {
		const url = new URL(input);
		calls.push({
			method: init.method ?? "GET",
			path: url.pathname,
			body: init.body ? JSON.parse(String(init.body)) : null,
		});
		return answers.shift() ?? new Response(null, { status: 500 });
	};
	const adapter = createFirebaseRealtime({
		client: createClient({ databaseURL: EMULATOR_URL, fetch }),
		connection: { provider: "firebase" },
	});
	return { adapter, calls };
};

const json = (value: unknown, etag = "etag") => new Response(JSON.stringify(value), { headers: { ETag: etag } });
const denied = () => new Response(null, { status: 401 });
const conflict = () => new Response(null, { status: 412 });
const silent = () => new Response(null, { status: 204 });

describe("Firebase realtime adapter", () => {
	it("never lowers a published revision and retries a lost compare-and-set", async () => {
		const stale = scripted(json({ revision: 9 }));
		await stale.adapter.publish("policies", 7);
		expect(stale.calls.map((call) => call.method)).toEqual(["GET"]);

		const raced = scripted(json({ revision: 1 }, "a"), conflict(), json({ revision: 2 }, "b"), json({ revision: 3 }));
		await raced.adapter.publish("policies", 3);
		expect(raced.calls.map((call) => [call.method, call.body])).toEqual([
			["GET", null],
			["PUT", { revision: 3 }],
			["GET", null],
			["PUT", { revision: 3 }],
		]);
	});

	it("skips a repeated grant and revokes atomically", async () => {
		const repeated = scripted(json({ rev: 4 }));
		await repeated.adapter.grant("user1", 4);
		expect(repeated.calls).toHaveLength(1);

		const revoked = scripted(silent(), silent());
		await revoked.adapter.revoke("user1", 5);
		expect(revoked.calls).toEqual([
			{ method: "PATCH", path: "/access.json", body: { "members/user1": null, "revoked/user1": 5 } },
			{ method: "DELETE", path: "/presence/user1.json", body: null },
		]);
	});

	it("treats a revocation older than the stored one as already done, and fails otherwise", async () => {
		const older = scripted(denied(), json(8), silent());
		await older.adapter.revoke("user1", 6);
		const refused = scripted(denied(), json(3));
		await expect(refused.adapter.revoke("user1", 6)).rejects.toMatchObject({ code: "denied" });
	});

	it("refuses ids that are not plain keys, and dispatcher uids unsafe for rules", async () => {
		const { adapter, calls } = scripted();
		await expect(adapter.grant("_tenant", 1)).rejects.toThrow(TypeError);
		await expect(adapter.publish("a/b", 1)).rejects.toThrow(TypeError);
		expect(calls).toEqual([]);
		expect(() => databaseRules("abc' || true || '")).toThrow(TypeError);
	});
});
