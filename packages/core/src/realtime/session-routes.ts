import { type ErrorCode, errorStatus, type RealtimeSession } from "@takebase/contracts";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AuthIdentity } from "../rules/types.ts";
import type { RealtimeAdapter } from "./adapter.ts";

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
		const { auth, accessRevision, adapter, granted } = resolve();
		if (!auth) return fail(c, "unauthenticated", "Authentication required");
		if (!adapter || accessRevision === null) return fail(c, "unavailable", "Realtime is not available");
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

	return routes;
};
