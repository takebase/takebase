import type { TokenSource } from "./auth.ts";
import { TakebaseError } from "./errors.ts";

// The subset of `fetch` the SDK calls; tests and server code can pass their own.
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type RequestOptions = { signal?: AbortSignal };

type Request = RequestOptions & { method: string; query?: URLSearchParams; body?: unknown };

export type Http = {
	// Resolves with the response of a request that reached the Worker.
	send: (path: string, request: Request) => Promise<Response>;
};

const isAbort = (error: unknown, signal: AbortSignal | undefined) =>
	signal?.aborted === true || (error instanceof Error && error.name === "AbortError");

// `baseUrl` must already be a safe base URL (see safeBaseUrl); paths are fixed
// by the SDK, so the token is only ever sent to that origin.
export const createHttp = (baseUrl: string, fetch: Fetch, token: TokenSource): Http => {
	const attempt = async (url: string, { method, body, signal }: Request, bearer: string | null) => {
		// An already aborted request is never sent, token included.
		if (signal?.aborted) throw new TakebaseError(0, "aborted", "The request was aborted", {}, { cause: signal.reason });
		const headers: Record<string, string> = { accept: "application/json" };
		if (body !== undefined) headers["content-type"] = "application/json";
		if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
		try {
			return await fetch(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal,
			});
		} catch (error) {
			if (isAbort(error, signal))
				throw new TakebaseError(0, "aborted", "The request was aborted", {}, { cause: error });
			throw new TakebaseError(0, "network", "The request could not reach the server", {}, { cause: error });
		}
	};

	// A 401 for a sent token may mean it just expired: refresh it once and retry.
	const send = async (path: string, request: Request) => {
		const search = request.query?.size ? `?${request.query}` : "";
		const url = `${baseUrl}${path}${search}`;
		const bearer = await token(false);
		const response = await attempt(url, request, bearer);
		if (response.status !== 401 || bearer === null) return response;
		const refreshed = await token(true);
		return refreshed === null ? response : attempt(url, request, refreshed);
	};

	return { send };
};
