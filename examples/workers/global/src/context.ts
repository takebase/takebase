import {
	createLogger,
	firebaseProvider,
	firebaseSettings,
	type IdentityProvider,
	type Logger,
	requestIdOf,
} from "@takebase/core";

// Composition root: settings, service clients and per-request values.
export type AppContext = {
	service: "global";
	db: D1Database;
	// The identity adapter that verifies bearer tokens (Firebase).
	identity: IdentityProvider;
	clientIp: string | null;
	// The correlation id, returned as `x-request-id` and on every log line.
	requestId: string;
	log: Logger;
	now: Date;
};

// firebaseSettings throws on an unsafe emulator configuration, so a
// misconfigured Worker fails every request instead of trusting unsigned tokens.
export const createContext = (env: CloudflareBindings, request?: Request): AppContext => {
	const requestId = requestIdOf(request);
	return {
		service: "global",
		db: env.DB,
		identity: firebaseProvider(firebaseSettings(env)),
		clientIp: request?.headers.get("cf-connecting-ip") ?? null,
		requestId,
		log: createLogger({ service: "global", requestId }),
		now: new Date(),
	};
};
