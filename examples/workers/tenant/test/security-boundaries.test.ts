import { env } from "cloudflare:workers";
import type { ErrorEnvelope } from "@takebase/contracts";
import {
	createDiagnosticsRoutes,
	createLogger,
	createRealtimeRoutes,
	type MembershipCheck,
	type MembershipVerifier,
	type RevocationSource,
} from "@takebase/core";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { fakeAdapter } from "./realtime/fake-adapter.ts";

// SEGU-228 (R-7-1-01): what the tenant Worker's public boundary must hold under
// overlapping requests, anonymous callers and oversized input.

const answers: Record<string, MembershipCheck> = {
	admin: { status: "member", identity: { id: "uid-admin", provider: "firebase", roles: ["admin"] }, revision: 1 },
	member: { status: "member", identity: { id: "uid-member", provider: "firebase", roles: ["member"] }, revision: 1 },
	agent: { status: "member", identity: { id: "uid-agent", provider: "firebase", roles: ["agent"] }, revision: 1 },
	outsider: { status: "not_member", subject: "uid-outsider", revision: 1 },
};
const instantly: MembershipVerifier = {
	verifyMembership: async (token) => answers[token] ?? { status: "invalid_token" },
};

const code = async (response: Response) => ((await response.json()) as ErrorEnvelope).error.code;

describe("overlapping requests (R-7-1-01)", () => {
	it("never share an identity, whichever membership answer arrives first", async () => {
		const tokens = Array.from({ length: 30 }, (_, index) => ["admin", "member", "outsider"][index % 3] ?? "");
		// Every request waits inside its membership check until all have started;
		// the answers then arrive newest first, so each scope resumes interleaved.
		const waiting: (() => void)[] = [];
		const overlapping: MembershipVerifier = {
			verifyMembership: async (token, tenantId) => {
				await new Promise<void>((resolve) => {
					waiting.push(resolve);
					if (waiting.length === tokens.length) for (const release of waiting.reverse()) release();
				});
				return instantly.verifyMembership(token, tenantId);
			},
		};
		const responses = await Promise.all(
			tokens.map((token) =>
				app.fetch(
					new Request("https://tenant.local/api/admin/diagnostics", { headers: { authorization: `Bearer ${token}` } }),
					{ ...env, GLOBAL: overlapping },
				),
			),
		);
		expect(responses.map(({ status }) => status)).toEqual(tokens.map((token) => (token === "admin" ? 200 : 403)));
		expect(new Set(responses.map((response) => response.headers.get("x-request-id"))).size).toBe(tokens.length);
	});
});

describe("authority-free delivery routes (R-7-1-01)", () => {
	const owed: RevocationSource = {
		pendingRevocation: async () => 41,
		confirmRevocation: async () => {},
		pendingMemberRevocations: async () => [
			{ provider: "firebase", subject: "uid-1", rev: 42 },
			{ provider: "firebase", subject: "uid-2", rev: 43 },
		],
		confirmMemberRevocation: async () => {},
	};

	it("reconcile delivers what is owed, and tells an anonymous caller nothing about it", async () => {
		const fake = fakeAdapter();
		const response = await createRealtimeRoutes({
			resolve: () => ({ auth: null, accessRevision: null, adapter: fake.adapter, revocations: owed, tenantId: "t" }),
		}).request("https://tenant.local/api/realtime/reconcile", { method: "POST" });
		expect(fake.calls.map(({ op }) => op)).toEqual(["revokeAll", "revoke", "revoke"]);
		expect([response.status, await response.json()]).toEqual([200, { ok: true }]);
	});

	it("dispatch delivers what is committed, and tells an anonymous caller nothing about it", async () => {
		await env.DB.prepare("delete from takebase_outbox").run();
		await env.DB.prepare(
			"insert into takebase_outbox (id, collection, operation, record_id, created, status, attempts, available_at) values ('evt-1', 'policies', 'update', 'r', ?1, 'pending', 0, ?1)",
		)
			.bind("2026-10-27T10:00:00.000Z")
			.run();
		const fake = fakeAdapter();
		const response = await createDiagnosticsRoutes({
			resolve: () => ({
				auth: null,
				db: env.DB,
				tenantId: "t",
				adapter: fake.adapter,
				revocations: null,
				log: createLogger({ service: "test" }),
				now: new Date(),
			}),
		}).request("https://tenant.local/api/realtime/dispatch", { method: "POST" });
		expect(fake.published()).toHaveLength(1);
		expect([response.status, await response.json()]).toEqual([200, { ok: true }]);
	});
});

describe("rate limit (R-7-1-01)", () => {
	const post = (path: string, success: boolean | "broken") =>
		app.fetch(
			new Request(`https://tenant.local${path}`, { method: "POST", headers: { authorization: "Bearer agent" } }),
			{
				...env,
				GLOBAL: instantly,
				RATE_LIMITER: {
					limit: async () => {
						if (success === "broken") throw new Error("limiter down");
						return { success };
					},
				},
			},
		);

	it("limits only the delivery routes anyone may trigger, and a broken limiter stops nothing", async () => {
		expect((await post("/api/realtime/dispatch", false)).status).toBe(429);
		expect((await post("/api/realtime/reconcile", false)).status).toBe(429);
		// No realtime is configured here, so what passes the limit answers 503.
		expect((await post("/api/realtime/session", false)).status).toBe(503);
		expect((await post("/api/realtime/dispatch", "broken")).status).toBe(503);
	});
});

describe("request size (R-7-1-01)", () => {
	const send = (body: string, token: string) =>
		app.fetch(
			new Request("https://tenant.local/api/collections/policies/records", {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body,
			}),
			{ ...env, GLOBAL: instantly },
		);

	it("refuses an oversized body before parsing it", async () => {
		const response = await send(JSON.stringify({ holder: "x".repeat(2 * 1024 * 1024) }), "agent");
		expect([response.status, await code(response)]).toEqual([413, "payload_too_large"]);
	});
});
