import { firebaseProvider, firebaseSettings, type IdentityProvider } from "@takebase/core";

// Composition root: settings, service clients and per-request values.
export type AppContext = {
	service: "global";
	db: D1Database;
	// The identity adapter that verifies bearer tokens (Firebase).
	identity: IdentityProvider;
	clientIp: string | null;
	now: Date;
};

// firebaseSettings throws on an unsafe emulator configuration, so a
// misconfigured Worker fails every request instead of trusting unsigned tokens.
export const createContext = (env: CloudflareBindings, request?: Request): AppContext => ({
	service: "global",
	db: env.DB,
	identity: firebaseProvider(firebaseSettings(env)),
	clientIp: request?.headers.get("cf-connecting-ip") ?? null,
	now: new Date(),
});
