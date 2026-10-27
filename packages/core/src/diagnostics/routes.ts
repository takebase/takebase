import {
	type DispatchCounts,
	type ErrorCode,
	errorStatus,
	type OutboxRetryResult,
	type TenantDiagnostics,
} from "@takebase/contracts";
import { sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { RealtimeAdapter } from "../realtime/adapter.ts";
import { deliverOutbox } from "../realtime/dispatcher.ts";
import type { RevocationSource } from "../realtime/revocations.ts";
import type { AuthIdentity } from "../rules/types.ts";
import { adminRoleName } from "../services/administration-d1-service.ts";
import { createOutboxService } from "../services/outbox-d1-service.ts";
import { type AnyD1Database, createDatabase } from "../storage/d1.ts";
import type { Logger } from "./log.ts";

// What the diagnostics endpoints need from the tenant Worker's composition root.
export type DiagnosticsRequest = {
	// The verified tenant member, set by the membership guard; null when anonymous.
	auth: AuthIdentity | null;
	db: AnyD1Database;
	tenantId: string;
	// Null when this Worker has no realtime settings.
	adapter: RealtimeAdapter | null;
	revocations?: RevocationSource | null;
	log: Logger;
	now: Date;
	// Delivers the outbox after the response (the Worker's waitUntil dispatch).
	dispatch?: () => void;
};

export type DiagnosticsRoutesOptions = { resolve: () => DiagnosticsRequest };

const maxDead = 50;
const maxRetryIds = 50;

const fail = (c: Context, code: ErrorCode, message: string) =>
	c.json({ error: { code, message } }, errorStatus[code] as ContentfulStatusCode);

// The admin gate: a member holding this tenant's built-in `admin` role. The
// membership guard already proved membership of this tenant only, so an admin
// of another tenant is not a member here.
const admin = (c: Context, auth: AuthIdentity | null) => {
	if (!auth) return fail(c, "unauthenticated", "Authentication required");
	if (!auth.roles.includes(adminRoleName)) return fail(c, "forbidden", "Only an admin of this tenant may do this");
	return null;
};

const appliedMigrations = async (db: AnyD1Database) => {
	try {
		const rows = await createDatabase(db).all<{ name: string }>(sql`select name from d1_migrations order by id`);
		return rows.map((row) => row.name);
	} catch {
		return [];
	}
};

const pendingRevocations = async (request: DiagnosticsRequest) => {
	if (!request.revocations) return null;
	try {
		const [tenant, members] = await Promise.all([
			request.revocations.pendingRevocation(request.tenantId),
			request.revocations.pendingMemberRevocations(request.tenantId),
		]);
		return { tenant, members: members.length };
	} catch (error) {
		request.log.warn("diagnostics.revocations_unavailable", { error });
		return null;
	}
};

const isRetryBody = (body: unknown): body is { ids: string[] } | { dead: true } => {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
	const keys = Object.keys(body);
	if (keys.length !== 1) return false;
	if ("dead" in body) return body.dead === true;
	const { ids } = body as { ids?: unknown };
	return (
		Array.isArray(ids) &&
		ids.length > 0 &&
		ids.length <= maxRetryIds &&
		ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64)
	);
};

// Outbox diagnostics and repair for one tenant Worker.
// - GET /api/admin/diagnostics and POST /api/admin/outbox/retry: this
//   tenant's admins only. Answers hold delivery metadata, never record fields.
// - POST /api/realtime/dispatch: authority-free, like reconcile. It only
//   publishes collection revisions already committed, so any caller may trigger
//   it and repeating it changes nothing; clients still refetch through the rules.
export const createDiagnosticsRoutes = ({ resolve }: DiagnosticsRoutesOptions) => {
	const routes = new Hono();

	routes.get("/api/admin/diagnostics", async (c) => {
		const request = resolve();
		const refused = admin(c, request.auth);
		if (refused) return refused;
		const outbox = createOutboxService(request.db);
		const [summary, dead, migrations, revocations] = await Promise.all([
			outbox.summary(),
			outbox.deadEvents(maxDead),
			appliedMigrations(request.db),
			pendingRevocations(request),
		]);
		const body: TenantDiagnostics = {
			tenantId: request.tenantId,
			outbox: { ...summary, dead },
			migrations,
			revocations,
			realtime: request.adapter !== null,
		};
		return c.json(body);
	});

	routes.post("/api/admin/outbox/retry", async (c) => {
		const request = resolve();
		const refused = admin(c, request.auth);
		if (refused) return refused;
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			body = undefined;
		}
		if (!isRetryBody(body)) {
			return fail(c, "bad_request", `Send {"ids": [...]} (1 to ${maxRetryIds} event ids) or {"dead": true}`);
		}
		const revived = await createOutboxService(request.db).revive(body, request.now);
		request.log.info("outbox.retry", {
			actor: request.auth?.id,
			selection: "ids" in body ? "ids" : "dead",
			requested: "ids" in body ? body.ids.length : null,
			revived,
		});
		if (revived > 0) request.dispatch?.();
		const result: OutboxRetryResult = { revived };
		return c.json(result);
	});

	routes.post("/api/realtime/dispatch", async (c) => {
		const { adapter, db, log } = resolve();
		if (!adapter) return fail(c, "unavailable", "Realtime is not available");
		try {
			const counts: DispatchCounts = await deliverOutbox({ outbox: createOutboxService(db), adapter });
			return c.json(counts);
		} catch (error) {
			log.error("realtime.dispatch_failed", { error });
			return fail(c, "unavailable", "Realtime delivery failed; events stay pending");
		}
	});

	return routes;
};
