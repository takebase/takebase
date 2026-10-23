import { createCollectionRoutes } from "@takebase/core";
import { Hono } from "hono";
import { collections } from "./collections/index.ts";
import { createContext } from "./context.ts";
import { runInRequest, useContext } from "./request-store.ts";

const checkDatabase = async () => {
	const row = await useContext().db.prepare("select 1 as ok").first<{ ok: number }>();
	return row?.ok === 1;
};

export const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use("*", (c, next) => runInRequest(createContext(c.env, c.req.raw), next));

app.get("/health", async (c) => {
	const { service, tenantId } = useContext();
	return c.json({ service, tenantId, status: "ok", database: (await checkDatabase()) ? "ok" : "error" });
});

app.route(
	"/",
	createCollectionRoutes({
		registry: collections,
		resolve: () => {
			const { db, auth, now } = useContext();
			return { db, auth, now };
		},
	}),
);
