import { errorStatus } from "@takebase/contracts";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Every Takebase request body is a small JSON object, so anything larger is
// refused before it is read or parsed. Workers would otherwise hold it in memory.
export const maxRequestBytes = 1024 * 1024;

export const requestSizeLimit: MiddlewareHandler = bodyLimit({
	maxSize: maxRequestBytes,
	onError: (c) =>
		c.json(
			{ error: { code: "payload_too_large", message: "The request body is too large" } },
			errorStatus.payload_too_large as ContentfulStatusCode,
		),
});
