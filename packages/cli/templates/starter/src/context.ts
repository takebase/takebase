// Composition root: settings, service clients and per-request values.
export type AppContext = {
	db: D1Database;
	clientIp: string | null;
	now: Date;
};

export const createContext = (env: CloudflareBindings, request?: Request): AppContext => ({
	db: env.DB,
	clientIp: request?.headers.get("cf-connecting-ip") ?? null,
	now: new Date(),
});
