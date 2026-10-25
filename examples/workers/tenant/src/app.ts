import {
	AuthError,
	authenticateTenantMember,
	createCollectionRoutes,
	createOutboxService,
	createRealtimeRoutes,
	dispatchOutbox,
} from "@takebase/core";
import { type Context, Hono } from "hono";
import { collections } from "./collections/index.ts";
import { createContext } from "./context.ts";
import { requestLocals, runInRequest, useContext } from "./request-store.ts";

const checkDatabase = async () => {
	const row = await useContext().db.prepare("select 1 as ok").first<{ ok: number }>();
	return row?.ok === 1;
};

// Hono throws when there is no ExecutionContext (e.g. app.request in tests).
const executionContext = (c: Context) => {
	try {
		return c.executionCtx;
	} catch {
		return undefined;
	}
};

// Sends committed outbox events to realtime after the response; there is no cron.
const dispatch = () => {
	const { realtime, db, waitUntil } = useContext();
	if (!realtime) return;
	waitUntil(
		dispatchOutbox({ outbox: createOutboxService(db), adapter: realtime }).catch((error) =>
			console.error("Realtime dispatch failed", error),
		),
	);
};

// The global Worker said this verified user is not a member: end any realtime
// access they still hold, at the revision of that answer.
const revoke = (subject: string, revision: number) => {
	const { realtime, waitUntil } = useContext();
	if (!realtime) return;
	waitUntil(realtime.revoke(subject, revision).catch((error) => console.error("Realtime revocation failed", error)));
};

export const app = new Hono<{ Bindings: CloudflareBindings }>();

// The tenant's membership guard (Laravel's `auth` middleware): the caller's
// identity comes only from the global Worker's answer for this tenant's own
// TENANT_ID. Headers naming a user, role or tenant are never read.
app.use("*", (c, next) =>
	runInRequest(createContext(c.env, c.req.raw, executionContext(c)), async () => {
		const { membership, tenantId } = useContext();
		try {
			const member = await authenticateTenantMember(membership, tenantId, c.req.header("authorization"), {
				notMember: revoke,
			});
			requestLocals.set("auth", member?.identity ?? null);
			requestLocals.set("accessRevision", member?.revision ?? null);
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
	createRealtimeRoutes({
		resolve: () => ({
			auth: requestLocals.get("auth") ?? null,
			accessRevision: requestLocals.get("accessRevision") ?? null,
			adapter: useContext().realtime,
			granted: dispatch,
		}),
	}),
);

app.route(
	"/",
	createCollectionRoutes({
		registry: collections,
		resolve: () => {
			const { db, now } = useContext();
			return { db, auth: requestLocals.get("auth") ?? null, now };
		},
		committed: dispatch,
	}),
);
