import { firebaseRealtime } from "@takebase/adapter-firebase";
import type { MembershipVerifier, RealtimeAdapter } from "@takebase/core";

// Composition root: settings, service clients and per-request values.
// Each tenant runs as its own Worker deployment bound to its own D1 database.
// The verified caller is a request local (`auth`), set by the membership guard.
export type AppContext = {
	service: "tenant";
	tenantId: string;
	db: D1Database;
	// The global Worker's MembershipEntrypoint, reached over the GLOBAL service binding.
	membership: MembershipVerifier;
	// This tenant's realtime service, or null when its dispatcher secrets are not set.
	realtime: RealtimeAdapter | null;
	// Keeps background work (dispatch, revocation) alive after the response.
	waitUntil: (work: Promise<unknown>) => void;
	clientIp: string | null;
	now: Date;
};

// The dispatcher user's credentials: Worker secrets, never vars (.dev.vars locally).
type RealtimeSecrets = { FIREBASE_DISPATCHER_EMAIL?: string; FIREBASE_DISPATCHER_PASSWORD?: string };

const createRealtime = (env: CloudflareBindings & RealtimeSecrets): RealtimeAdapter | null => {
	const { FIREBASE_DATABASE_URL, FIREBASE_API_KEY, FIREBASE_DISPATCHER_EMAIL, FIREBASE_DISPATCHER_PASSWORD } = env;
	if (!FIREBASE_DATABASE_URL || !FIREBASE_API_KEY || !FIREBASE_DISPATCHER_EMAIL || !FIREBASE_DISPATCHER_PASSWORD) {
		return null;
	}
	return firebaseRealtime({
		databaseURL: FIREBASE_DATABASE_URL,
		apiKey: FIREBASE_API_KEY,
		email: FIREBASE_DISPATCHER_EMAIL,
		password: FIREBASE_DISPATCHER_PASSWORD,
		namespace: env.FIREBASE_DATABASE_NAMESPACE,
	});
};

export const createContext = (
	env: CloudflareBindings,
	request?: Request,
	execution?: Pick<ExecutionContext, "waitUntil">,
): AppContext => ({
	service: "tenant",
	tenantId: env.TENANT_ID,
	db: env.DB,
	membership: env.GLOBAL as unknown as MembershipVerifier,
	realtime: createRealtime(env),
	waitUntil: (work) => (execution ? execution.waitUntil(work) : void work),
	clientIp: request?.headers.get("cf-connecting-ip") ?? null,
	now: new Date(),
});
