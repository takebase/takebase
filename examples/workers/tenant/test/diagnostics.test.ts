import { env } from "cloudflare:workers";
import type { DispatchCounts, ErrorEnvelope, OutboxRetryResult, TenantDiagnostics } from "@takebase/contracts";
import {
	type AuthIdentity,
	createDiagnosticsRoutes,
	createLogger,
	type MembershipCheck,
	type MembershipVerifier,
	type RevocationSource,
} from "@takebase/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { fakeAdapter } from "./realtime/fake-adapter.ts";

// SEGU-221 (S-5-3-01, security): outbox diagnostics and repair are private to
// this tenant's admins, expose delivery metadata only, and a retry republishes
// collection revisions, never records.

const recordId = "5f0c7c3e-6f1d-4e57-9a43-2b8f4d7c9e11";

const insertEvent = (id: string, status: "pending" | "delivered" | "dead", deliveredAt: string | null = null) =>
	env.DB.prepare(
		"insert into takebase_outbox (id, collection, operation, record_id, created, status, attempts, available_at, delivered_at) values (?, 'policies', 'update', ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			id,
			recordId,
			"2026-10-27T10:00:00.000Z",
			status,
			status === "dead" ? 10 : 1,
			"2026-10-27T10:00:00.000Z",
			deliveredAt,
		)
		.run();

const statuses = async () =>
	(
		await env.DB.prepare("select id, status, attempts from takebase_outbox order by seq").all<{
			id: string;
			status: string;
			attempts: number;
		}>()
	).results;

// The global Worker as the tenant sees it: membership answers by token, and
// no pending revocations.
const member = (roles: string[]): MembershipCheck => ({
	status: "member",
	identity: { id: `uid-${roles.join("-") || "none"}`, provider: "firebase", roles },
	revision: 1,
});
const answers: Record<string, MembershipCheck> = {
	admin: member(["admin"]),
	member: member(["member"]),
	// An admin of another tenant is not a member of this one.
	"other-admin": { status: "not_member", subject: "uid-other-admin", revision: 1 },
};
const global: MembershipVerifier & RevocationSource = {
	verifyMembership: async (token) => answers[token] ?? { status: "invalid_token" },
	pendingRevocation: async () => null,
	confirmRevocation: async () => {},
	pendingMemberRevocations: async () => [],
	confirmMemberRevocation: async () => {},
};

const send = (path: string, token?: string, init: RequestInit = {}) =>
	app.fetch(
		new Request(`https://tenant.local${path}`, {
			...init,
			headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		}),
		{ ...env, GLOBAL: global },
	);

const code = async (response: Response) => ((await response.json()) as ErrorEnvelope).error.code;

beforeEach(async () => {
	await env.DB.prepare("delete from takebase_outbox").run();
	await insertEvent("evt-pending", "pending");
	await insertEvent("evt-dead-1", "dead");
	await insertEvent("evt-dead-2", "dead");
	await insertEvent("evt-old", "delivered", "2026-01-01T00:00:00.000Z");
});

describe("tenant outbox diagnostics (SEGU-221)", () => {
	it("only this tenant's admins inspect or retry, and they see delivery metadata only", async () => {
		const retryAll = { method: "POST", body: JSON.stringify({ dead: true }) };
		for (const [token, status, error] of [
			[undefined, 401, "unauthenticated"],
			["member", 403, "forbidden"],
			["other-admin", 403, "forbidden"],
		] as const) {
			const inspect = await send("/api/admin/diagnostics", token);
			expect([inspect.status, await code(inspect)]).toEqual([status, error]);
			const retry = await send("/api/admin/outbox/retry", token, retryAll);
			expect([retry.status, await code(retry)]).toEqual([status, error]);
		}
		expect((await statuses()).filter(({ status }) => status === "dead")).toHaveLength(2);

		const response = await send("/api/admin/diagnostics", "admin");
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain(recordId);
		expect(text).not.toContain("record_id");
		const body = JSON.parse(text) as TenantDiagnostics;
		expect(body).toMatchObject({
			tenantId: env.TENANT_ID,
			outbox: { counts: { pending: 1, delivered: 1, dead: 2 }, oldestPending: "2026-10-27T10:00:00.000Z" },
			revocations: { tenant: null, members: 0 },
			realtime: false,
		});
		expect(body.outbox.dead.map(({ id }) => id)).toEqual(["evt-dead-2", "evt-dead-1"]);
		expect(Object.keys(body.outbox.dead[0] ?? {}).sort()).toEqual(
			["attempts", "availableAt", "collection", "created", "id", "operation", "seq"].sort(),
		);
		expect(body.migrations.length).toBeGreaterThan(0);

		for (const bad of [{}, { ids: [] }, { ids: Array(51).fill("x") }, { dead: false }, { dead: true, ids: ["x"] }]) {
			const refused = await send("/api/admin/outbox/retry", "admin", { method: "POST", body: JSON.stringify(bad) });
			expect([refused.status, await code(refused)]).toEqual([400, "bad_request"]);
		}
	});

	it("an admin retry revives only the chosen dead events; delivery publishes revisions, never records", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fake = fakeAdapter();
		const admin: AuthIdentity = { id: "uid-admin", provider: "firebase", roles: ["admin"] };
		const dispatch = vi.fn();
		const routes = createDiagnosticsRoutes({
			resolve: () => ({
				auth: admin,
				db: env.DB,
				tenantId: env.TENANT_ID,
				adapter: fake.adapter,
				revocations: null,
				log: createLogger({ service: "tenant", tenantId: env.TENANT_ID, requestId: "test-request" }),
				now: new Date(),
				dispatch,
			}),
		});
		const post = (path: string, body?: unknown) =>
			routes.request(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

		const retried = await post("/api/admin/outbox/retry", { ids: ["evt-dead-1", "evt-pending", "evt-unknown"] });
		expect((await retried.json()) as OutboxRetryResult).toEqual({ revived: 1 });
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(await statuses()).toEqual([
			{ id: "evt-pending", status: "pending", attempts: 1 },
			{ id: "evt-dead-1", status: "pending", attempts: 0 },
			{ id: "evt-dead-2", status: "dead", attempts: 10 },
			{ id: "evt-old", status: "delivered", attempts: 1 },
		]);
		const line = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
		expect(line).toMatchObject({ event: "outbox.retry", actor: "uid-admin", revived: 1, requestId: "test-request" });

		// The authority-free flush: counts only; delivered past retention is pruned.
		const flushed = await post("/api/realtime/dispatch");
		expect((await flushed.json()) as DispatchCounts).toEqual({ delivered: 2, failed: 0, pruned: 1 });
		for (const args of fake.published()) {
			expect(args).toEqual(["policies", expect.any(Number)]);
			expect(JSON.stringify(args)).not.toContain(recordId);
		}
		expect((await statuses()).map(({ id, status }) => [id, status])).toEqual([
			["evt-pending", "delivered"],
			["evt-dead-1", "delivered"],
			["evt-dead-2", "dead"],
		]);
	});

	it("readiness names failing dependencies without saying why", async () => {
		const error = vi.spyOn(console, "warn").mockImplementation(() => {});
		// The default GLOBAL binding is an unavailable Worker without RPC methods.
		const response = await app.fetch(new Request("https://tenant.local/health/ready"), env);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			service: "tenant",
			tenantId: env.TENANT_ID,
			status: "error",
			checks: { database: "ok", global: "error", realtime: "unconfigured" },
		});
		expect(error).toHaveBeenCalled();
	});
});
