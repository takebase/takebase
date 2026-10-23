// Composition root: settings, service clients and per-request values.
export type AppContext = {
	service: "global";
	db: D1Database;
	clientIp: string | null;
	now: Date;
};

export const createContext = (env: CloudflareBindings, request?: Request): AppContext => ({
	service: "global",
	db: env.DB,
	clientIp: request?.headers.get("cf-connecting-ip") ?? null,
	now: new Date(),
});
