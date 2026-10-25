import { env } from "cloudflare:workers";
import { createOutboxService, type DispatchOptions, dispatchOutbox } from "@takebase/core";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizedRoutes, countPolicies, json, newPolicy } from "../fixtures.ts";
import { fakeAdapter } from "./fake-adapter.ts";

const base = "https://tenant.local/api/collections/policies/records";
const outbox = () => createOutboxService(env.DB);
// Events are created at the real time; dispatch runs on a clock after that.
const start = Date.now() + 60_000;
const clock =
	(offsetMs = 0) =>
	() =>
		new Date(start + offsetMs);

const seed = async (count: number) => {
	const routes = authorizedRoutes();
	for (let i = 0; i < count; i++) expect((await routes.request(base, json("POST", newPolicy()))).status).toBe(201);
};

const statuses = async () =>
	(await env.DB.prepare("select status from takebase_outbox order by seq").all<{ status: string }>()).results.map(
		(row) => row.status,
	);

const dispatch = (fake: ReturnType<typeof fakeAdapter>, options: Partial<DispatchOptions> = {}) =>
	dispatchOutbox({ outbox: outbox(), adapter: fake.adapter, now: clock(), ...options });

beforeEach(async () => {
	await env.DB.prepare("delete from takebase_outbox").run();
});

describe("R-4-2-01 / S-4-2-01: dispatching the outbox", () => {
	it("publishes one signal per collection at its highest revision and acknowledges the events", async () => {
		await seed(3);
		const revisions = (
			await env.DB.prepare("select seq from takebase_outbox order by seq").all<{ seq: number }>()
		).results.map((row) => row.seq);
		const fake = fakeAdapter();
		expect(await dispatch(fake)).toEqual({ delivered: 3, failed: 0 });
		expect(fake.published()).toEqual([["policies", Math.max(...revisions)]]);
		expect(await statuses()).toEqual(["delivered", "delivered", "delivered"]);
		expect(await dispatch(fake)).toEqual({ delivered: 0, failed: 0 });
	});

	it("keeps failed work in the outbox with backoff and never touches D1 data", async () => {
		await seed(2);
		const records = await countPolicies();
		const fake = fakeAdapter();
		fake.failNext(1);
		expect(await dispatch(fake)).toEqual({ delivered: 0, failed: 2 });
		expect(await statuses()).toEqual(["pending", "pending"]);
		expect(await countPolicies()).toBe(records);
		// The first retry waits one second.
		expect(await dispatch(fake, { now: clock(999) })).toEqual({ delivered: 0, failed: 0 });
		expect(await dispatch(fake, { now: clock(1_000) })).toEqual({ delivered: 2, failed: 0 });
		expect(fake.published()).toHaveLength(2);
	});

	it("parks events as dead after the maximum attempts", async () => {
		await seed(1);
		const fake = fakeAdapter();
		fake.failNext(99);
		await dispatch(fake, { maxAttempts: 2 });
		await dispatch(fake, { maxAttempts: 2, now: clock(60_000) });
		expect(await statuses()).toEqual(["dead"]);
		expect(await dispatch(fake, { maxAttempts: 2, now: clock(3_600_000) })).toEqual({ delivered: 0, failed: 0 });
	});

	it("recovers events a crashed dispatcher had claimed once their lease expires", async () => {
		await seed(2);
		// A dispatcher claims, then dies before publishing or acknowledging.
		await outbox().claim({ limit: 50, leaseMs: 30_000, now: clock()() });
		const fake = fakeAdapter();
		expect(await dispatch(fake, { now: clock(1_000) })).toEqual({ delivered: 0, failed: 0 });
		expect(await dispatch(fake, { now: clock(30_000) })).toEqual({ delivered: 2, failed: 0 });
	});

	it("concurrent dispatchers deliver every event exactly once in the outbox", async () => {
		await seed(6);
		const fake = fakeAdapter();
		const results = await Promise.all([dispatch(fake, { batchSize: 2 }), dispatch(fake, { batchSize: 2 })]);
		expect(results.reduce((sum, result) => sum + result.delivered, 0)).toBe(6);
		expect(await statuses()).toEqual(Array(6).fill("delivered"));
	});

	it("stops claiming new batches once its time budget is spent", async () => {
		await seed(5);
		const fake = fakeAdapter();
		// Each clock read moves 20 s forward, past the 10 s budget after one batch.
		let tick = 0;
		const slow = () => new Date(start + 20_000 * tick++);
		expect(await dispatch(fake, { batchSize: 2, now: slow })).toEqual({ delivered: 2, failed: 0 });
		expect(await dispatch(fake, { batchSize: 2, now: clock(60_000) })).toEqual({ delivered: 3, failed: 0 });
	});
});

describe("after-commit dispatch hook", () => {
	it("runs only after a write actually committed", async () => {
		let commits = 0;
		const routes = authorizedRoutes(undefined, () => commits++);
		const created = await routes.request(base, json("POST", newPolicy()));
		const { id } = (await created.json()) as { id: string };
		await routes.request(`${base}/${id}`, json("PATCH", { status: "active" }));
		await routes.request(`${base}/${id}`, json("DELETE"));
		expect(commits).toBe(3);
		// Invalid, missing and already-deleted writes commit nothing.
		await routes.request(base, json("POST", { holder: "x" }));
		await routes.request(`${base}/${id}`, json("PATCH", { status: "active" }));
		await routes.request(`${base}/${id}`, json("DELETE"));
		expect(commits).toBe(3);
	});
});
