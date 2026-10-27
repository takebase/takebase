import { browserCors, checkReadiness, createLogger } from "@takebase/core";
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

// Unexpected failures: one redacted log line, and a generic envelope that never
// carries the error itself. Outside a request scope (the composition root
// failed) the line has no request id.
app.onError((error, c) => {
	let log = createLogger({ service: "global" });
	try {
		log = useContext().log;
	} catch {}
	log.error("request.unhandled", { method: c.req.method, path: c.req.path, error });
	return c.json({ error: { code: "internal", message: "Internal error" } }, 500);
});
app.use("*", (c, next) =>
	runInRequest(createContext(c.env, c.req.raw), async () => {
		c.header("x-request-id", useContext().requestId);
		await next();
	}),
);

app.get("/health", async (c) => {
	const { service } = useContext();
	return c.json({ service, status: "ok", database: (await checkDatabase()) ? "ok" : "error" });
});

// Dependency readiness; `/health` above stays the plain liveness answer.
app.get("/health/ready", async (c) => {
	const { service, log } = useContext();
	const readiness = await checkReadiness(service, { database: checkDatabase }, log);
	return c.json(readiness, readiness.status === "error" ? 503 : 200);
});

app.route("/api/tenants", tenantRoutes);
app.route("/api/admin/tenants", adminRoutes);
app.route("/api/invites", inviteRoutes);
