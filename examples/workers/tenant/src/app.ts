import {
	AuthError,
	authenticateTenantMember,
	browserCors,
	checkReadiness,
	createCollectionAdminRoutes,
	createCollectionRoutes,
	createDiagnosticsRoutes,
	createLogger,
	createOutboxService,
	createRealtimeRoutes,
	createSecretsRoutes,
	deliverOutbox,
} from "@takebase/core";
import { type Context, Hono } from "hono";
import { collections } from "./collections/index.ts";
import { createContext } from "./context.ts";
import { requestLocals, runInRequest, useContext } from "./request-store.ts";

// Set per deployment (locally with `wrangler dev --var`); not in wrangler.jsonc.
type BrowserVars = { CORS_ORIGINS?: string };

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

// Sends committed outbox events to realtime after the response, then prunes
// delivered events past retention; there is no cron.
const dispatch = () => {
	const { realtime, db, waitUntil, log } = useContext();
	if (!realtime) return;
	waitUntil(
		deliverOutbox({ outbox: createOutboxService(db), adapter: realtime }).catch((error) =>
			log.error("realtime.dispatch_failed", { error }),
		),
	);
};

// The global Worker said this verified user is not a member: end any realtime
// access they still hold, at the revision of that answer.
const revoke = (subject: string, revision: number) => {
	const { realtime, waitUntil, log } = useContext();
	if (!realtime) return;
	waitUntil(
		realtime.revoke(subject, revision).catch((error) => log.error("realtime.revocation_failed", { revision, error })),
	);
};

export const app = new Hono<{ Bindings: CloudflareBindings & BrowserVars }>();

// Browser apps on other origins (CORS_ORIGINS, unset by default). Preflights are
// answered here, before the membership guard.
app.use("*", (c, next) => browserCors(c.env.CORS_ORIGINS)(c, next));

// Unexpected failures: one redacted log line, and a generic envelope that never
// carries the error itself. Outside a request scope (the composition root
// failed) the line has no request id.
app.onError((error, c) => {
	let log = createLogger({ service: "tenant" });
	try {
		log = useContext().log;
	} catch {}
	log.error("request.unhandled", { method: c.req.method, path: c.req.path, error });
	return c.json({ error: { code: "internal", message: "Internal error" } }, 500);
});

// The tenant's membership guard (Laravel's `auth` middleware): the caller's
// identity comes only from the global Worker's answer for this tenant's own
// TENANT_ID. Headers naming a user, role or tenant are never read.
app.use("*", (c, next) =>
	runInRequest(createContext(c.env, c.req.raw, executionContext(c)), async () => {
		const { membership, tenantId, requestId } = useContext();
		c.header("x-request-id", requestId);
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

// Secrets readiness: no key installed yet is "unconfigured" (the Worker
// serves without secrets); a key that cannot open KV's canary is an error.
// The check writes the canary on first use, with random bytes only.
const checkSecrets = async () => {
	const { secrets } = useContext();
	if (!secrets) return "unconfigured" as const;
	const state = await secrets.check();
	return state === "ok" ? true : state === "mismatch" ? false : ("unconfigured" as const);
};

// Dependency readiness; `/health` above stays the plain liveness answer. The
// global check reads this tenant's pending revocation over the RPC binding;
// realtime is only checked for settings, so health never signs in to Firebase.
app.get("/health/ready", async (c) => {
	const { service, tenantId, revocations, realtime, log } = useContext();
	const readiness = await checkReadiness(
		service,
		{
			database: checkDatabase,
			global: async () => {
				await revocations.pendingRevocation(tenantId);
				return true;
			},
			realtime: async () => (realtime ? true : "unconfigured"),
			secrets: checkSecrets,
		},
		log,
	);
	return c.json({ ...readiness, tenantId }, readiness.status === "error" ? 503 : 200);
});

app.route(
	"/",
	createRealtimeRoutes({
		resolve: () => ({
			auth: requestLocals.get("auth") ?? null,
			accessRevision: requestLocals.get("accessRevision") ?? null,
			adapter: useContext().realtime,
			granted: dispatch,
			tenantId: useContext().tenantId,
			revocations: useContext().revocations,
		}),
	}),
);

app.route(
	"/",
	createDiagnosticsRoutes({
		resolve: () => {
			const { db, tenantId, realtime, revocations, log, now } = useContext();
			return {
				auth: requestLocals.get("auth") ?? null,
				db,
				tenantId,
				adapter: realtime,
				revocations,
				log,
				now,
				dispatch,
			};
		},
	}),
);

app.route(
	"/",
	createSecretsRoutes({
		resolve: () => {
			const { tenantId, environment, secrets } = useContext();
			return { auth: requestLocals.get("auth") ?? null, tenantId, environment, secrets };
		},
	}),
);

app.route(
	"/",
	createCollectionAdminRoutes({ registry: collections, resolve: () => ({ auth: requestLocals.get("auth") ?? null }) }),
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
