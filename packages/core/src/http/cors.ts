import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

// CORS for browser apps on other origins, off unless the Worker lists origins.
// `origins` is a comma-separated list of exact origins (no wildcards), e.g.
// "http://localhost:5173". Requests carry bearer tokens, never cookies, so no
// credentials mode is enabled. Origins not listed get no CORS headers.
export const browserCors = (origins: string | undefined): MiddlewareHandler => {
	const allowed = new Set(
		(origins ?? "")
			.split(",")
			.map((origin) => origin.trim())
			.filter((origin) => origin !== ""),
	);
	if (allowed.size === 0) return async (_c, next) => next();
	return cors({
		origin: (origin) => (allowed.has(origin) ? origin : null),
		allowMethods: ["GET", "POST", "PATCH", "DELETE"],
		allowHeaders: ["authorization", "content-type"],
		maxAge: 600,
	});
};
