import { env } from "cloudflare:workers";
import type { CollectionRecord, ErrorEnvelope } from "@takebase/contracts";
import {
	type CollectionHooks,
	type CollectionRules,
	createCollectionRegistry,
	createCollectionRoutes,
	defineCollection,
	HookError,
} from "@takebase/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agents } from "../src/schema/agents.ts";
import { policies } from "../src/schema/policies.ts";
import { internalIdentity, json, newPolicy } from "./fixtures.ts";

const base = "https://tenant.local/api/collections/hooked/records";
const allowAll: CollectionRules = {
	list: () => true,
	view: () => true,
	create: () => true,
	update: () => true,
	delete: () => true,
};

// The policies table behind a collection with test hooks. `calls` records each
// hook in order, so tests can prove what ran before and after the write.
const hooked = (hooks: CollectionHooks, rules: CollectionRules = allowAll, unique = true) => {
	const calls: string[] = [];
	const record =
		(name: keyof CollectionHooks) =>
		(...args: unknown[]) => {
			calls.push(name);
			return (hooks[name] as ((...hookArgs: unknown[]) => unknown) | undefined)?.(...args);
		};
	const wrapped = Object.fromEntries(Object.keys(hooks).map((name) => [name, record(name as keyof CollectionHooks)]));
	const routes = createCollectionRoutes({
		registry: createCollectionRegistry(
			[
				defineCollection({
					table: policies,
					name: "hooked",
					rules,
					validate: {
						number: `required|string|max:32${unique ? "|unique" : ""}`,
						holder: "required|string|min:2|max:120",
						status: "required|in:pending,active,cancelled",
						agent_id: "nullable|string|exists:agents,id",
					},
					hooks: wrapped,
				}),
			],
			{ tables: [agents] },
		),
		resolve: () => ({ db: env.DB, auth: internalIdentity, now: new Date() }),
	});
	return { calls, routes };
};

const stored = async (number: string) =>
	env.DB.prepare("select * from policies where number = ?").bind(number).first<CollectionRecord>();
const errorOf = async (response: Response) => ((await response.json()) as ErrorEnvelope).error;

describe("collection hooks on tenant D1 (authorized fixture)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("transform input before the write and see the stored record after it", async () => {
		const seen: unknown[] = [];
		const { calls, routes } = hooked({
			creating: (data, context) => {
				seen.push(Object.keys(context).sort());
				return { ...data, number: String(data.number).toUpperCase() };
			},
			created: (record) => {
				seen.push(record);
			},
		});
		const input = newPolicy({ number: `hook-${crypto.randomUUID().slice(0, 8)}` });
		const response = await routes.request(base, json("POST", input));
		expect(response.status).toBe(201);
		const record = (await response.json()) as CollectionRecord<{ number: string }>;
		expect(record.number).toBe(String(input.number).toUpperCase());
		expect(await stored(record.number)).toEqual(record);
		expect(calls).toEqual(["creating", "created"]);
		// Hooks get identity and collection only: no database, env or request.
		expect(seen).toEqual([["auth", "collection"], record]);
	});

	it("validate a before-hook's output again, so it cannot store what a client could not", async () => {
		const taken = newPolicy();
		expect((await hooked({}).routes.request(base, json("POST", taken))).status).toBe(201);

		const cases: [CollectionHooks["creating"], string][] = [
			[(data) => ({ ...data, number: "X".repeat(33) }), "number"],
			[(data) => ({ ...data, number: taken.number }), "number"],
			[(data) => ({ ...data, status: "deleted" }), "status"],
			[(data) => ({ ...data, agent_id: "no-such-agent" }), "agent_id"],
		];
		for (const [creating, field] of cases) {
			const input = newPolicy();
			const { calls, routes } = hooked({ creating, created: () => {} });
			const response = await routes.request(base, json("POST", input));
			expect(response.status, field).toBe(422);
			expect(Object.keys((await errorOf(response)).fields ?? {}), field).toEqual([field]);
			expect(calls).toEqual(["creating"]);
			expect(await stored(input.number)).toBeNull();
		}
	});

	it("never run before the rule allows the operation and the input validates", async () => {
		const hooks: CollectionHooks = { creating: () => {}, updating: () => {}, deleting: () => {}, deleted: () => {} };
		const allowed = hooked({});
		const created = (await (await allowed.routes.request(base, json("POST", newPolicy()))).json()) as CollectionRecord;

		const denied = hooked(hooks, {});
		expect((await denied.routes.request(base, json("POST", newPolicy()))).status).toBe(403);
		expect((await denied.routes.request(`${base}/${created.id}`, json("PATCH", { status: "active" }))).status).toBe(
			403,
		);
		expect((await denied.routes.request(`${base}/${created.id}`, { method: "DELETE" })).status).toBe(403);
		expect(denied.calls).toEqual([]);

		const invalid = hooked(hooks);
		expect((await invalid.routes.request(base, json("POST", { number: "" }))).status).toBe(422);
		expect((await invalid.routes.request(`${base}/${created.id}`, json("PATCH", { status: "x" }))).status).toBe(422);
		expect((await invalid.routes.request(`${base}/${created.id}`, json("PATCH", { id: "x" }))).status).toBe(422);
		expect(invalid.calls).toEqual([]);

		const missing = "00000000-0000-4000-8000-000000000000";
		expect((await invalid.routes.request(`${base}/${missing}`, json("PATCH", { status: "active" }))).status).toBe(404);
		expect((await invalid.routes.request(`${base}/${missing}`, { method: "DELETE" })).status).toBe(404);
		expect(invalid.calls).toEqual([]);
	});

	it("cancel an operation with a HookError before anything is written", async () => {
		const input = newPolicy();
		const blocked = hooked({
			creating: () => {
				throw new HookError("validation_failed", "The given data was invalid.", { holder: "The holder is blocked." });
			},
			created: () => {},
		});
		const response = await blocked.routes.request(base, json("POST", input));
		expect(response.status).toBe(422);
		expect(await errorOf(response)).toEqual({
			code: "validation_failed",
			message: "The given data was invalid.",
			fields: { holder: "The holder is blocked." },
		});
		expect(blocked.calls).toEqual(["creating"]);
		expect(await stored(input.number)).toBeNull();

		const record = (await (
			await hooked({}).routes.request(base, json("POST", newPolicy()))
		).json()) as CollectionRecord;
		const guarded = hooked({
			updating: () => {
				throw new HookError("forbidden", "Active policies are locked");
			},
			deleting: () => {
				throw new HookError("conflict", "The policy has open claims");
			},
			updated: () => {},
			deleted: () => {},
		});
		const update = await guarded.routes.request(`${base}/${record.id}`, json("PATCH", { status: "active" }));
		expect(update.status).toBe(403);
		expect(await errorOf(update)).toEqual({ code: "forbidden", message: "Active policies are locked" });
		const remove = await guarded.routes.request(`${base}/${record.id}`, { method: "DELETE" });
		expect(remove.status).toBe(409);
		expect(guarded.calls).toEqual(["updating", "deleting"]);
		expect(await stored(String(record.number))).toEqual(record);
	});

	it("reject non-writable fields from a hook as a server error without writing", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		for (const extra of [{ id: "forced" }, { created: "2000-01-01T00:00:00.000Z" }, { notes: "private" }]) {
			const input = newPolicy();
			const { calls, routes } = hooked({ creating: (data) => ({ ...data, ...extra }), created: () => {} });
			const response = await routes.request(base, json("POST", input));
			expect(response.status, JSON.stringify(extra)).toBe(500);
			expect(await errorOf(response)).toEqual({ code: "internal", message: "Internal error" });
			expect(calls).toEqual(["creating"]);
			expect(await stored(input.number)).toBeNull();
		}
	});

	it("give update and delete hooks the current record, and run after-hooks only once the write succeeded", async () => {
		const seen: Record<string, unknown> = {};
		const { calls, routes } = hooked({
			updating: (data, { id, record }) => {
				seen.updating = { id, status: record.status };
				return { ...data, holder: "Grace Hopper" };
			},
			updated: (record) => {
				seen.updated = record;
			},
			deleting: ({ record }) => {
				seen.deleting = record.holder;
			},
			deleted: ({ id }) => {
				seen.deleted = id;
			},
		});
		const created = (await (await routes.request(base, json("POST", newPolicy()))).json()) as CollectionRecord;
		const response = await routes.request(`${base}/${created.id}`, json("PATCH", { status: "active" }));
		const updated = (await response.json()) as CollectionRecord;
		expect(updated).toMatchObject({ status: "active", holder: "Grace Hopper" });
		expect(seen).toEqual({ updating: { id: created.id, status: "pending" }, updated });

		expect((await routes.request(`${base}/${created.id}`, { method: "DELETE" })).status).toBe(204);
		expect(seen).toMatchObject({ deleting: "Grace Hopper", deleted: created.id });
		expect(calls).toEqual(["updating", "updated", "deleting", "deleted"]);
		expect(await stored(String(created.number))).toBeNull();
	});

	it("skip after-hooks when the write fails, and keep the response when an after-hook fails", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const taken = newPolicy();
		expect((await hooked({}).routes.request(base, json("POST", taken))).status).toBe(201);

		// Without the unique rule only the D1 unique index catches the duplicate:
		// the write fails, so the after-hook (the side effect) never runs.
		const conflict = hooked({ creating: () => {}, created: () => {} }, allowAll, false);
		const duplicate = await conflict.routes.request(base, json("POST", newPolicy({ number: taken.number })));
		expect(duplicate.status).toBe(409);
		expect(conflict.calls).toEqual(["creating"]);

		const input = newPolicy();
		const failing = hooked({
			created: () => {
				throw new Error("notification service down");
			},
		});
		const response = await failing.routes.request(base, json("POST", input));
		expect(response.status).toBe(201);
		expect(await stored(input.number)).toEqual(await response.json());
		expect(failing.calls).toEqual(["created"]);
		expect(log).toHaveBeenCalledOnce();
	});
});
