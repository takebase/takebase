import type { TenantListResponse } from "@takebase/contracts";
import { authenticate, createMembershipsService, InvalidTokenError } from "@takebase/core";
import { Hono } from "hono";
import { useContext } from "../request-store.ts";

const unauthenticated = { error: { code: "unauthenticated", message: "Invalid or expired token" } } as const;

// GET /api/tenants: the caller's active tenant memberships, from global D1.
export const tenantRoutes = new Hono<{ Bindings: CloudflareBindings }>().get("/", async (c) => {
	const { identity, db, now } = useContext();
	let verified: Awaited<ReturnType<typeof authenticate>>;
	try {
		verified = await authenticate(identity, c.req.header("authorization"), now);
	} catch (error) {
		if (error instanceof InvalidTokenError) return c.json(unauthenticated, 401);
		throw error;
	}
	if (verified === null) return c.json({ error: { code: "unauthenticated", message: "Authentication required" } }, 401);
	const body: TenantListResponse = { tenants: await createMembershipsService(db).list(verified) };
	return c.json(body);
});
