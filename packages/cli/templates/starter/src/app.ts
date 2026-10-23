import { Hono } from "hono";
import { createContext } from "./context.ts";
import { runInRequest, useContext } from "./request-store.ts";

const checkDatabase = async () => {
	const row = await useContext().db.prepare("select 1 as ok").first<{ ok: number }>();
	return row?.ok === 1;
};

export const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use("*", (c, next) => runInRequest(createContext(c.env, c.req.raw), next));

app.get("/health", async (c) => c.json({ status: "ok", database: (await checkDatabase()) ? "ok" : "error" }));
