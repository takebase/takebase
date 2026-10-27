import { browserCors } from "@takebase/core";
import { Hono } from "hono";
import { createContext } from "./context.ts";
import { runInRequest, useContext } from "./request-store.ts";
import { adminRoutes } from "./routes/admin.ts";
import { inviteRoutes } from "./routes/invites.ts";
import { tenantRoutes } from "./routes/tenants.ts";

// Set per deployment (locally with `wrangler dev --var`); not in wrangler.jsonc.
type BrowserVars = { CORS_ORIGINS?: string };

const checkDatabase = async () => {
	const row = await useContext().db.prepare("select 1 as ok").first<{ ok: number }>();
	return row?.ok === 1;
};

export const app = new Hono<{ Bindings: CloudflareBindings & BrowserVars }>();

// Browser apps on other origins (CORS_ORIGINS, unset by default).
app.use("*", (c, next) => browserCors(c.env.CORS_ORIGINS)(c, next));
app.use("*", (c, next) => runInRequest(createContext(c.env, c.req.raw), next));

app.get("/health", async (c) => {
	const { service } = useContext();
	return c.json({ service, status: "ok", database: (await checkDatabase()) ? "ok" : "error" });
});

app.route("/api/tenants", tenantRoutes);
app.route("/api/admin/tenants", adminRoutes);
app.route("/api/invites", inviteRoutes);
