import { env } from "cloudflare:workers";
import {
	type AuthIdentity,
	type CollectionRules,
	createCollectionRegistry,
	createCollectionRoutes,
	defineCollection,
} from "@takebase/core";
import type { FirebaseAuthLike } from "@takebase/sdk";
import { policiesCollection } from "../src/collections/policies.ts";
import { agents } from "../src/schema/agents.ts";
import { policies } from "../src/schema/policies.ts";

// An explicit internal identity for test-only routes. Production Workers resolve
// identity only through the global Worker's membership check.
export const internalIdentity: AuthIdentity = { id: "test-internal", provider: "internal", roles: [] };

// The real policies collection (validation, filters, sorts, hooks) with every
// operation open, so CRUD, query and SDK mechanics can be tested on their own.
// Its real rules are tested through the deployed Worker (policies-access.test.ts).
const open: CollectionRules = {
	list: () => true,
	view: () => true,
	create: () => true,
	update: () => true,
	delete: () => true,
};
const crudCollections = createCollectionRegistry([Object.freeze({ ...policiesCollection, rules: open })], {
	tables: [agents],
});

export const authorizedRoutes = (now = () => new Date(), committed?: () => void) =>
	createCollectionRoutes({
		registry: crudCollections,
		resolve: () => ({ db: env.DB, auth: internalIdentity, now: now() }),
		committed,
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

// A Firebase Auth stand-in whose ID token is the user id itself; null is signed out.
export const testAuth = (uid: string | null): FirebaseAuthLike => ({
	currentUser: uid === null ? null : { uid, getIdToken: async () => uid },
	onIdTokenChanged: () => () => {},
	signOut: async () => {},
});

export const tenantMembership = (url: string) => ({
	tenant: { id: env.TENANT_ID, name: env.TENANT_ID, url },
	roles: ["member"],
});
