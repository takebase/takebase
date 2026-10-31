import { errorStatus } from "@takebase/contracts";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Cloudflare's Rate Limiting binding. Its counters are approximate and per
// location: this limits abuse, it does not guarantee a cap.
export type RateLimiter = { limit: (options: { key: string }) => Promise<{ success: boolean }> };

// Limits work anyone can trigger, per client address within `scope`. Off without
// a binding, and a limiter failure lets the request through: these routes deliver
// revocations, so an outage of the limiter must not stop them.
export const rateLimit =
	(limiter: RateLimiter | undefined, scope: string): MiddlewareHandler =>
	async (c, next) => {
		const key = `${scope}:${c.req.header("cf-connecting-ip") ?? "unknown"}`;
		const allowed = await limiter?.limit({ key }).then(
			({ success }) => success,
			() => true,
		);
		if (allowed === false) {
			return c.json(
				{ error: { code: "rate_limited", message: "Too many requests; try again shortly" } },
				errorStatus.rate_limited as ContentfulStatusCode,
			);
		}
		await next();
	};
