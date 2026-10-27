import { type ErrorCode, errorStatus, type RealtimeSession } from "@takebase/contracts";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AuthIdentity } from "../rules/types.ts";
import type { RealtimeAdapter } from "./adapter.ts";
import { type RevocationSource, reconcileRevocation } from "./revocations.ts";

// What the session endpoint needs from the Worker's composition root, per request.
export type RealtimeRequest = {
	// The verified tenant member, set by the membership guard; null when anonymous.
	auth: AuthIdentity | null;
	// The tenant's access revision returned with that membership check.
	accessRevision: number | null;
	// Null when this Worker has no realtime service configured.
	adapter: RealtimeAdapter | null;
	// Runs after a grant succeeds; the Worker uses it to flush pending signals.
	granted?: () => void;
	// This tenant's id and the global Worker's revocation RPC, for reconcile.
	tenantId?: string;
	revocations?: RevocationSource | null;
};

export type RealtimeRoutesOptions = { resolve: () => RealtimeRequest };

const fail = (c: Context, code: ErrorCode, message: string) =>
	c.json({ error: { code, message } }, errorStatus[code] as ContentfulStatusCode);

// POST /api/realtime/session: a member opens (or reopens) realtime. The
// membership guard already asked the global Worker on this request, so the
// grant carries that answer's access revision; a grant older than a later
// revocation is rejected by the adapter.
export const createRealtimeRoutes = ({ resolve }: RealtimeRoutesOptions) => {
	const routes = new Hono();

	routes.post("/api/realtime/session", async (c) => {
		const { auth, accessRevision, adapter, granted, revocations, tenantId } = resolve();
		if (!auth) return fail(c, "unauthenticated", "Authentication required");
		if (!adapter || accessRevision === null) return fail(c, "unavailable", "Realtime is not available");
		// Deliver whatever the tenant still owes before granting, so a pending
		// revocation is never written after (and over) this grant. A failure only
		// leaves it pending; the session still opens.
		if (revocations && tenantId !== undefined) {
			try {
				await reconcileRevocation(revocations, adapter, tenantId);
			} catch (error) {
				console.error("Realtime revocation failed; it stays pending", error);
			}
		}
		try {
			await adapter.grant(auth.id, accessRevision);
		} catch (error) {
			console.error("Realtime grant failed", error);
			return fail(c, "unavailable", "Realtime is not available");
		}
		granted?.();
		const session: RealtimeSession = { uid: auth.id, revision: accessRevision, connection: { ...adapter.connection } };
		return c.json(session);
	});

	// POST /api/realtime/reconcile: delivers the revocations global D1 recorded
	// for this tenant (tenant disabled; members removed, disabled or with
	// revoked sessions). The call carries no authority: the tenant
	// Worker asks the global Worker what is owed and only ever revokes, so any
	// caller may trigger it, and repeating it changes nothing.
	routes.post("/api/realtime/reconcile", async (c) => {
		const { adapter, revocations, tenantId } = resolve();
		if (!adapter || !revocations || tenantId === undefined) {
			return fail(c, "unavailable", "Realtime is not available");
		}
		try {
			return c.json(await reconcileRevocation(revocations, adapter, tenantId));
		} catch (error) {
			console.error("Realtime revocation failed", error);
			return fail(c, "unavailable", "Realtime revocation failed; it stays pending");
		}
	});

	return routes;
};
