import { type ErrorCode, errorStatus, type FieldErrors } from "@takebase/contracts";
import { AdminError, authenticate, ensureAccepted, InvalidTokenError } from "@takebase/core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { useContext } from "../request-store.ts";

// Shared by the admin and invitation routes: the error envelope, and the
// caller's verified identity (a valid token Takebase still accepts).

export const fail = (c: Context, code: ErrorCode, message: string, fields?: FieldErrors) =>
	c.json({ error: { code, message, ...(fields ? { fields } : {}) } }, errorStatus[code] as ContentfulStatusCode);

// Null when the request carries no valid, accepted token.
export const verifiedCaller = async (c: Context) => {
	const { identity, db, now } = useContext();
	try {
		const verified = await authenticate(identity, c.req.header("authorization"), now);
		return verified === null ? null : await ensureAccepted(db, verified);
	} catch (error) {
		if (error instanceof InvalidTokenError) return null;
		throw error;
	}
};

export const unauthenticated = (c: Context) => fail(c, "unauthenticated", "Invalid or expired token");

// Turns an AdminError from the administration service into its envelope.
export const handled =
	(handler: (c: Context) => Promise<Response>) =>
	async (c: Context): Promise<Response> => {
		try {
			return await handler(c);
		} catch (error) {
			if (error instanceof AdminError) return fail(c, error.code, error.message, error.fields);
			throw error;
		}
	};

export const jsonBody = async (c: Context): Promise<Record<string, unknown>> => {
	try {
		const body: unknown = await c.req.json();
		if (typeof body === "object" && body !== null && !Array.isArray(body)) return body as Record<string, unknown>;
	} catch {}
	throw new AdminError("bad_request", "The request body must be a JSON object");
};
