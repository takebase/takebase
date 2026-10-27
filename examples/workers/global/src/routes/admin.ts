import type { MemberRemoval } from "@takebase/contracts";
import { actorOf, createAdministrationService } from "@takebase/core";
import { type Context, Hono } from "hono";
import { requestLocals, useContext } from "../request-store.ts";
import { fail, handled, jsonBody, unauthenticated, verifiedCaller } from "./caller.ts";

// /api/admin/tenants/:tenantId/…: tenant administration for holders of that
// tenant's built-in `admin` role, and only for that tenant. There is no
// superuser here: the platform operator works through the CLI instead.
// Every change is audited with the caller as actor; the D1 triggers refuse
// undeclared roles and the removal of a tenant's last admin.

const service = () => {
	const { db, now } = useContext();
	return createAdministrationService(db, now);
};
// Set by the guard below before any handler runs.
const actor = () => {
	const caller = requestLocals.get("caller");
	if (!caller) throw new Error("admin route reached without its guard");
	return actorOf(caller);
};
const tenantOf = (c: Context) => c.req.param("tenantId") ?? "";

export const adminRoutes = new Hono<{ Bindings: CloudflareBindings }>();

// The guard: a valid accepted token, holding `admin` in this active tenant.
// An unknown tenant looks the same as one the caller does not administer.
adminRoutes.use("/:tenantId/*", async (c, next) => {
	const caller = await verifiedCaller(c);
	if (caller === null) return unauthenticated(c);
	if (!(await service().isAdmin(caller, c.req.param("tenantId")))) {
		return fail(c, "forbidden", "Only an admin of this tenant may do this");
	}
	requestLocals.set("caller", caller);
	await next();
});

adminRoutes.get(
	"/:tenantId/members",
	handled(async (c) => c.json({ members: await service().listMembers(tenantOf(c)) })),
);

adminRoutes.post(
	"/:tenantId/members",
	handled(async (c) => {
		const { uid, role } = await jsonBody(c);
		await service().addMember(actor(), tenantOf(c), uid, role);
		return c.json({ uid, role }, 201);
	}),
);

adminRoutes.delete(
	"/:tenantId/members/:uid",
	handled(async (c) => {
		const tenantId = tenantOf(c);
		await service().removeMember(actor(), tenantId, c.req.param("uid"), c.req.query("role"));
		const url = await service().tenantUrl(tenantId);
		const body: MemberRemoval = { reconcile: `${url}/api/realtime/reconcile` };
		return c.json(body);
	}),
);

adminRoutes.get(
	"/:tenantId/roles",
	handled(async (c) => c.json({ roles: await service().listRoles(tenantOf(c)) })),
);

adminRoutes.post(
	"/:tenantId/roles",
	handled(async (c) => {
		const { name } = await jsonBody(c);
		await service().createRole(actor(), tenantOf(c), name);
		return c.json({ name }, 201);
	}),
);

adminRoutes.delete(
	"/:tenantId/roles/:name",
	handled(async (c) => {
		await service().deleteRole(actor(), tenantOf(c), c.req.param("name"));
		return c.json({ deleted: c.req.param("name") });
	}),
);

adminRoutes.get(
	"/:tenantId/invites",
	handled(async (c) => c.json({ invites: await service().listInvites(tenantOf(c)) })),
);

adminRoutes.post(
	"/:tenantId/invites",
	handled(async (c) => {
		const { role, expiresInHours } = await jsonBody(c);
		return c.json(await service().createInvite(actor(), tenantOf(c), role, expiresInHours ?? 72), 201);
	}),
);

adminRoutes.delete(
	"/:tenantId/invites/:id",
	handled(async (c) => {
		await service().revokeInvite(actor(), tenantOf(c), c.req.param("id") ?? "");
		return c.json({ revoked: c.req.param("id") });
	}),
);
