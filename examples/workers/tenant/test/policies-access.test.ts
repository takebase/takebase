import { env } from "cloudflare:workers";
import type { ErrorEnvelope } from "@takebase/contracts";
import type { AuthIdentity, MembershipCheck, MembershipVerifier } from "@takebase/core";
import { createClient, type Fetch, TakebaseError } from "@takebase/sdk";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { countPolicies, tenantMembership, testAuth } from "./fixtures.ts";

type PolicyFields = { number: string; holder: string; status: "pending" | "active" | "cancelled" };

const tenantUrl = "https://tenant.local";
const base = `${tenantUrl}/api/collections/policies/records`;

// An explicit test-only stand-in for the global Worker: tokens are user ids,
// and only "agent" and "member" belong to this tenant.
const identities: Record<string, AuthIdentity> = {
	agent: { id: "agent", provider: "firebase", roles: ["member", "agent"] },
	member: { id: "member", provider: "firebase", roles: ["member"] },
};
const global: MembershipVerifier = {
	verifyMembership: async (token, tenantId): Promise<MembershipCheck> => {
		const identity = identities[token];
		if (token === "outsider") return { status: "not_member", subject: "outsider", revision: 1 };
		if (tenantId !== env.TENANT_ID || !identity) return { status: "invalid_token" };
		return { status: "member", identity, revision: 1 };
	},
};

// The deployed tenant app with the real policies rules and this request's GLOBAL.
const tenantFetch: Fetch = async (url, init) => app.fetch(new Request(url, init), { ...env, GLOBAL: global });

const policiesFor = async (uid: string) => {
	const client = createClient({
		globalUrl: "https://global.local",
		auth: testAuth(uid),
		fetch: async (url, init) =>
			url === "https://global.local/api/tenants"
				? Response.json({ tenants: [tenantMembership(tenantUrl)] })
				: tenantFetch(url, init),
	});
	await client.useTenant(env.TENANT_ID);
	return client.collection<PolicyFields>("policies");
};

const failure = async (promise: Promise<unknown>) => {
	const error = await promise.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(TakebaseError);
	return error as TakebaseError;
};

const asOutsider = async (path: string, init: RequestInit = {}) => {
	const response = await tenantFetch(`${base}${path}`, {
		...init,
		headers: { authorization: "Bearer outsider", "content-type": "application/json" },
	});
	return [response.status, ((await response.json()) as ErrorEnvelope).error.code];
};

describe("policies access through the SDK and the tenant Worker (S-3-2-01)", () => {
	it("agents create, members update, nobody deletes and outsiders cannot read, count or change", async () => {
		const asAgent = await policiesFor("agent");
		const asMember = await policiesFor("member");
		const number = `S321-${env.TENANT_ID}-${crypto.randomUUID().slice(0, 8)}`;

		const created = await asAgent.create({ number, holder: "Ada Lovelace", status: "pending" });
		expect(await failure(asMember.create({ number: `${number}-m`, holder: "Ada", status: "pending" }))).toMatchObject({
			status: 403,
			code: "forbidden",
		});
		expect(await asMember.update(created.id, { status: "active" })).toMatchObject({ id: created.id, status: "active" });
		for (const client of [asAgent, asMember])
			expect(await failure(client.delete(created.id))).toMatchObject({ status: 403, code: "forbidden" });

		const assign = await failure(
			asAgent.update(created.id, { tenant_id: "other", roles: ["admin"] } as unknown as { status: "active" }),
		);
		expect(assign).toMatchObject({ status: 422, code: "validation_failed" });
		expect(Object.keys(assign.fields).sort()).toEqual(["roles", "tenant_id"]);

		const before = await countPolicies();
		expect(await asOutsider("?perPage=1")).toEqual([403, "forbidden"]);
		expect(await asOutsider(`/${created.id}`)).toEqual([403, "forbidden"]);
		expect(
			await asOutsider(`/${created.id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) }),
		).toEqual([403, "forbidden"]);
		expect(await asOutsider(`/${created.id}`, { method: "DELETE" })).toEqual([403, "forbidden"]);
		expect(await countPolicies()).toBe(before);
		expect(await asMember.view(created.id)).toMatchObject({ status: "active" });
	});
});
