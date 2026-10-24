import type { MembershipVerifier } from "@takebase/core";

// Composition root: settings, service clients and per-request values.
// Each tenant runs as its own Worker deployment bound to its own D1 database.
// The verified caller is a request local (`auth`), set by the membership guard.
export type AppContext = {
	service: "tenant";
	tenantId: string;
	db: D1Database;
	// The global Worker's MembershipEntrypoint, reached over the GLOBAL service binding.
	membership: MembershipVerifier;
	clientIp: string | null;
	now: Date;
};

export const createContext = (env: CloudflareBindings, request?: Request): AppContext => ({
	service: "tenant",
	tenantId: env.TENANT_ID,
	db: env.DB,
	membership: env.GLOBAL as unknown as MembershipVerifier,
	clientIp: request?.headers.get("cf-connecting-ip") ?? null,
	now: new Date(),
});
