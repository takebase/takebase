import { firebaseRealtime } from "@takebase/adapter-firebase";
import {
	createLogger,
	createSecretsService,
	dataKeysFrom,
	type Logger,
	type MembershipVerifier,
	type RealtimeAdapter,
	type RevocationSource,
	requestIdOf,
	type SecretsService,
} from "@takebase/core";

// Composition root: settings, service clients and per-request values.
// Each tenant runs as its own Worker deployment bound to its own D1 database.
// The verified caller is a request local (`auth`), set by the membership guard.
export type AppContext = {
	service: "tenant";
	tenantId: string;
	db: D1Database;
	// The global Worker's MembershipEntrypoint, reached over the GLOBAL service binding.
	membership: MembershipVerifier;
	// Tenant-wide realtime revocations recorded in global D1, over the same binding.
	revocations: RevocationSource;
	// This tenant's realtime service, or null when its dispatcher secrets are not set.
	realtime: RealtimeAdapter | null;
	// This tenant's encrypted secrets (SEGU-223), or null without a SECRETS KV
	// binding. Worker-internal: no route accepts or returns a secret value.
	secrets: SecretsService | null;
	// Keeps background work (dispatch, revocation) alive after the response.
	waitUntil: (work: Promise<unknown>) => void;
	clientIp: string | null;
	// The correlation id, returned as `x-request-id` and on every log line.
	requestId: string;
	log: Logger;
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

// The data keys are Worker secrets (`DATA_KEY_V<n>`), read only here; the
// imported keys live in this request's service and nowhere else.
const createSecrets = (env: CloudflareBindings, now: Date): SecretsService | null => {
	if (!env.SECRETS || !env.TAKEBASE_ENV) return null;
	return createSecretsService({
		kv: env.SECRETS,
		keys: dataKeysFrom(env as unknown as Record<string, unknown>),
		tenantId: env.TENANT_ID,
		environment: env.TAKEBASE_ENV,
		now: () => now,
	});
};

export const createContext = (
	env: CloudflareBindings,
	request?: Request,
	execution?: Pick<ExecutionContext, "waitUntil">,
): AppContext => {
	const requestId = requestIdOf(request);
	const now = new Date();
	return {
		service: "tenant",
		tenantId: env.TENANT_ID,
		db: env.DB,
		membership: env.GLOBAL as unknown as MembershipVerifier,
		revocations: env.GLOBAL as unknown as RevocationSource,
		realtime: createRealtime(env),
		secrets: createSecrets(env, now),
		waitUntil: (work) => (execution ? execution.waitUntil(work) : void work),
		clientIp: request?.headers.get("cf-connecting-ip") ?? null,
		requestId,
		log: createLogger({ service: "tenant", tenantId: env.TENANT_ID, requestId }),
		now,
	};
};
