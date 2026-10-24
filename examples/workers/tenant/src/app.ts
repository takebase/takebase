import { AuthError, authenticateTenantMember, createCollectionRoutes } from "@takebase/core";
import { Hono } from "hono";
import { collections } from "./collections/index.ts";
import { createContext } from "./context.ts";
import { requestLocals, runInRequest, useContext } from "./request-store.ts";

const checkDatabase = async () => {
	const row = await useContext().db.prepare("select 1 as ok").first<{ ok: number }>();
	return row?.ok === 1;
};

export const app = new Hono<{ Bindings: CloudflareBindings }>();

// The tenant's membership guard (Laravel's `auth` middleware): the caller's
// identity comes only from the global Worker's answer for this tenant's own
// TENANT_ID. Headers naming a user, role or tenant are never read.
app.use("*", (c, next) =>
	runInRequest(createContext(c.env, c.req.raw), async () => {
		const { membership, tenantId } = useContext();
		try {
			requestLocals.set("auth", await authenticateTenantMember(membership, tenantId, c.req.header("authorization")));
		} catch (error) {
			if (!(error instanceof AuthError)) throw error;
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		}
		await next();
	}),
);

app.get("/health", async (c) => {
	const { service, tenantId } = useContext();
	return c.json({ service, tenantId, status: "ok", database: (await checkDatabase()) ? "ok" : "error" });
});

app.route(
	"/",
	createCollectionRoutes({
		registry: collections,
		resolve: () => {
			const { db, now } = useContext();
			return { db, auth: requestLocals.get("auth") ?? null, now };
		},
	}),
);
