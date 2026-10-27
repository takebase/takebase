import { createAdministrationService } from "@takebase/core";
import { Hono } from "hono";
import { useContext } from "../request-store.ts";
import { handled, jsonBody, unauthenticated, verifiedCaller } from "./caller.ts";

// POST /api/invites/redeem: the signed-in caller redeems an invitation token
// for its role. A token works once, before it expires, while the tenant is
// active; any other token gets the same 404, so nothing can be learned from it.
export const inviteRoutes = new Hono<{ Bindings: CloudflareBindings }>().post(
	"/redeem",
	handled(async (c) => {
		const caller = await verifiedCaller(c);
		if (caller === null) return unauthenticated(c);
		const { token } = await jsonBody(c);
		const { db, now } = useContext();
		return c.json(await createAdministrationService(db, now).redeem(caller, token));
	}),
);
