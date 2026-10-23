import { env } from "cloudflare:workers";
import { type AuthIdentity, createCollectionRegistry, createCollectionRoutes, defineCollection } from "@takebase/core";
import { collections } from "../src/collections/index.ts";
import { policies } from "../src/schema/policies.ts";

// Test-only routes over the real tenant registry and D1 binding with an explicit
// internal identity. Production Workers resolve no identity until Wave 3.
export const internalIdentity: AuthIdentity = { id: "test-internal" };

export const authorizedRoutes = (now = () => new Date()) =>
	createCollectionRoutes({
		registry: collections,
		resolve: () => ({ db: env.DB, auth: internalIdentity, now: now() }),
	});

// The same table with no rules at all: every operation must be denied.
export const lockedRoutes = () =>
	createCollectionRoutes({
		registry: createCollectionRegistry([
			defineCollection({ table: policies, name: "locked_policies", rules: {}, validate: { holder: "string" } }),
		]),
		resolve: () => ({ db: env.DB, auth: internalIdentity, now: new Date() }),
	});

// The policies table validated without unique/exists, standing in for a request
// that passed those checks just before a concurrent write: only D1 constraints remain.
export const uncheckedRoutes = () =>
	createCollectionRoutes({
		registry: createCollectionRegistry([
			defineCollection({
				table: policies,
				name: "unchecked_policies",
				rules: { create: () => true, update: () => true },
				validate: { number: "string", holder: "string", status: "string", agent_id: "nullable|string" },
			}),
		]),
		resolve: () => ({ db: env.DB, auth: internalIdentity, now: new Date() }),
	});

export const addAgent = async (id: string) => {
	await env.DB.prepare("insert or ignore into agents (id, name) values (?, ?)").bind(id, `Agent ${id}`).run();
	return id;
};

export const json = (method: string, body?: unknown): RequestInit => ({
	method,
	headers: { "content-type": "application/json" },
	body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
});

export const countPolicies = async (db: D1Database = env.DB) =>
	(await db.prepare("select count(*) as total from policies").first<{ total: number }>())?.total ?? 0;

let sequence = 0;
export const newPolicy = (overrides: Record<string, unknown> = {}) => ({
	number: `POL-${env.TENANT_ID}-${Date.now()}-${sequence++}`,
	holder: "Ada Lovelace",
	status: "pending",
	...overrides,
});
