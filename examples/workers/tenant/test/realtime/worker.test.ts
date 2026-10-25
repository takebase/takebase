import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { MembershipVerifier } from "@takebase/core";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { countPolicies, json, newPolicy } from "../fixtures.ts";

const agent: MembershipVerifier = {
	verifyMembership: async () => ({
		status: "member",
		identity: { id: "agent1", provider: "firebase", roles: ["member", "agent"] },
		revision: 3,
	}),
};

// The deployed app, waiting for its background work (dispatch) to finish.
const send = async (path: string, init: RequestInit, overrides: Record<string, string> = {}) => {
	const execution = createExecutionContext();
	const request = new Request(`https://tenant.local${path}`, {
		...init,
		headers: { ...init.headers, authorization: "Bearer agent" },
	});
	const response = await app.fetch(request, { ...env, GLOBAL: agent, ...overrides }, execution);
	await waitOnExecutionContext(execution);
	return response;
};

describe("tenant Worker realtime wiring (R-4-2-01)", () => {
	it("without dispatcher secrets realtime is off and the API still works", async () => {
		expect((await send("/api/realtime/session", { method: "POST" })).status).toBe(503);
		expect((await send("/api/collections/policies/records", json("POST", newPolicy()))).status).toBe(201);
	});

	it("a realtime failure keeps the event in the outbox and never reverts the committed record", async () => {
		// The dispatcher user does not exist (or no emulator runs): every realtime call fails.
		const broken = {
			FIREBASE_DISPATCHER_EMAIL: "missing-dispatcher@example.test",
			FIREBASE_DISPATCHER_PASSWORD: "wrong-password",
			FIREBASE_DATABASE_NAMESPACE: `demo-takebase-broken-${Date.now()}`,
		};
		const before = await countPolicies();
		const created = await send("/api/collections/policies/records", json("POST", newPolicy()), broken);
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		expect(await countPolicies()).toBe(before + 1);
		const event = await env.DB.prepare("select status, attempts from takebase_outbox where record_id = ?")
			.bind(id)
			.first<{ status: string; attempts: number }>();
		expect(event).toEqual({ status: "pending", attempts: 1 });
		expect((await send("/api/realtime/session", { method: "POST" }, broken)).status).toBe(503);
	});
});
