import { env, exports } from "cloudflare:workers";
import type { ErrorEnvelope } from "@takebase/contracts";
import type { MembershipCheck, MembershipVerifier } from "@takebase/core";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.ts";

const policies = "https://tenant.local/api/collections/policies/records";

// An explicit test-only stand-in for the global Worker's MembershipEntrypoint,
// passed as this request's GLOBAL binding; it records what the tenant asked.
const globalWorker = (answers: Record<string, MembershipCheck>) => {
	const calls: { token: string; tenantId: string }[] = [];
	const verifier: MembershipVerifier = {
		verifyMembership: async (token, tenantId) => {
			calls.push({ token, tenantId });
			return answers[token] ?? { status: "invalid_token" };
		},
	};
	return { calls, verifier };
};

// Client-supplied identity claims the tenant must ignore.
const spoofed = { "x-tenant-id": "other-tenant", "x-user-id": "admin", "x-roles": "owner" };

const errorCode = async (response: Response) => ((await response.json()) as ErrorEnvelope).error.code;

describe("tenant membership guard (S-3-1-01)", () => {
	it("authenticates members only through the global Worker for its own tenant", async () => {
		const global = globalWorker({
			member: { status: "member", identity: { id: "user-1", provider: "firebase", roles: ["editor"] } },
			outsider: { status: "not_member" },
		});
		const request = (token?: string) =>
			app.fetch(
				new Request(policies, { headers: { ...spoofed, ...(token ? { authorization: `Bearer ${token}` } : {}) } }),
				{ ...env, GLOBAL: global.verifier },
			);

		expect((await request("member")).status).toBe(200);
		const outsider = await request("outsider");
		expect([outsider.status, await errorCode(outsider)]).toEqual([403, "forbidden"]);
		const forged = await request("forged");
		expect([forged.status, await errorCode(forged)]).toEqual([401, "unauthenticated"]);
		const anonymous = await request();
		expect([anonymous.status, await errorCode(anonymous)]).toEqual([401, "unauthenticated"]);

		expect(global.calls.map(({ tenantId }) => tenantId)).toEqual([env.TENANT_ID, env.TENANT_ID, env.TENANT_ID]);
	});

	it("fails closed with 503 when the global Worker cannot answer", async () => {
		const response = await exports.default.fetch(policies, { headers: { authorization: "Bearer any-token" } });
		expect([response.status, await errorCode(response)]).toEqual([503, "unavailable"]);
	});
});
