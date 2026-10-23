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

export const createHttp = (baseUrl: string, fetch: Fetch): Http => {
	const base = baseUrl.replace(/\/+$/, "");

	const send = async (path: string, { method, query, body, signal }: Request) => {
		const search = query?.size ? `?${query}` : "";
		const headers: Record<string, string> = { accept: "application/json" };
		if (body !== undefined) headers["content-type"] = "application/json";
		try {
			return await fetch(`${base}${path}${search}`, {
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

	return { send };
};
