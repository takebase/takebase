// Composition root: settings, service clients and per-request values.
// Each tenant runs as its own Worker deployment bound to its own D1 database.
export type AppContext = {
	service: "tenant";
	tenantId: string;
	db: D1Database;
	clientIp: string | null;
	now: Date;
};

export const createContext = (env: CloudflareBindings, request?: Request): AppContext => ({
	service: "tenant",
	tenantId: env.TENANT_ID,
	db: env.DB,
	clientIp: request?.headers.get("cf-connecting-ip") ?? null,
	now: new Date(),
});
