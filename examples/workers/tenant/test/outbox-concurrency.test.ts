import { env } from "cloudflare:workers";
import { createOutboxService } from "@takebase/core";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizedRoutes, json, newPolicy } from "./fixtures.ts";

const base = "https://tenant.local/api/collections/policies/records";
const outbox = () => createOutboxService(env.DB);
const at = (ms: number) => new Date(Date.UTC(2030, 0, 1) + ms);
const lease = { leaseMs: 30_000 };

// Each test starts from an empty outbox and commits `count` real changes.
const seed = async (count: number) => {
	await env.DB.prepare("delete from takebase_outbox").run();
	const routes = authorizedRoutes();
	for (let i = 0; i < count; i++) {
		expect((await routes.request(base, json("POST", newPolicy()))).status).toBe(201);
	}
};

const statusOf = async (id: string) =>
	env.DB.prepare("select status, attempts from takebase_outbox where id = ?").bind(id).first();

describe("S-4-1-01: concurrent dispatchers cannot lose or share work", () => {
	beforeEach(() => seed(12));

	it("concurrent claims partition the pending events", async () => {
		const claims = await Promise.all(
			Array.from({ length: 4 }, () => outbox().claim({ limit: 5, now: at(0), ...lease })),
		);
		const revisions = claims.flatMap((claim) => claim.events.map((event) => event.revision));
		expect(revisions).toHaveLength(12);
		expect(new Set(revisions).size).toBe(12);
		for (const claim of claims) {
			const ids = claim.events.map((event) => event.id);
			expect(await outbox().acknowledge(claim.token, ids, at(1))).toEqual(expect.arrayContaining(ids));
		}
		expect((await outbox().claim({ limit: 50, now: at(2), ...lease })).events).toEqual([]);
	});

	it("an abandoned lease is reclaimed, and the stale holder cannot acknowledge", async () => {
		const first = await outbox().claim({ limit: 50, now: at(0), ...lease });
		expect(first.events).toHaveLength(12);
		expect((await outbox().claim({ limit: 50, now: at(1_000), ...lease })).events).toEqual([]);

		const second = await outbox().claim({ limit: 50, now: at(30_000), ...lease });
		expect(second.events.map((event) => event.id)).toEqual(first.events.map((event) => event.id));
		expect(await outbox().acknowledge(first.token, [first.events[0]?.id ?? ""], at(30_001))).toEqual([]);
		expect(await outbox().acknowledge(second.token, [second.events[0]?.id ?? ""], at(30_001))).toHaveLength(1);
		expect(await statusOf(second.events[0]?.id ?? "")).toEqual({ status: "delivered", attempts: 2 });
	});

	it("a failed event is retried after its backoff, then parked as dead", async () => {
		await seed(1);
		const retry = (token: string, id: string, ms: number) =>
			outbox().retry(token, id, { retryAt: at(ms), maxAttempts: 2 });

		const first = await outbox().claim({ limit: 1, now: at(0), ...lease });
		const id = first.events[0]?.id ?? "";
		expect(await retry(first.token, id, 60_000)).toBe(true);
		expect(await statusOf(id)).toEqual({ status: "pending", attempts: 1 });
		// Not claimable before its backoff ends.
		expect((await outbox().claim({ limit: 1, now: at(59_999), ...lease })).events).toEqual([]);

		const second = await outbox().claim({ limit: 1, now: at(60_000), ...lease });
		expect(second.events[0]?.id).toBe(id);
		expect(await retry(second.token, id, 120_000)).toBe(true);
		expect(await statusOf(id)).toEqual({ status: "dead", attempts: 2 });
		expect((await outbox().claim({ limit: 1, now: at(999_999), ...lease })).events).toEqual([]);
		// A stale token can no longer change the event.
		expect(await retry(first.token, id, 0)).toBe(false);
	});
});
