export type Call = { url: URL; init: RequestInit };

/** The recorded call at index, failing the test if it was never made. */
export const at = (calls: Call[], index: number): Call => {
	const call = calls[index];
	if (!call) throw new Error(`expected request #${index}`);
	return call;
};
export type Handler = (call: Call) => Response | Promise<Response>;

/** A scripted fetch: each request is answered by the next handler in order. */
export const scriptedFetch = (...handlers: (Handler | Response)[]) => {
	const calls: Call[] = [];
	const fetch = async (input: string, init: RequestInit): Promise<Response> => {
		const call = { url: new URL(input), init };
		calls.push(call);
		const handler = handlers.shift();
		if (!handler) throw new Error(`unexpected request ${init.method} ${call.url.pathname}`);
		return handler instanceof Response ? handler : handler(call);
	};
	return { fetch, calls, remaining: () => handlers.length };
};

export const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

export const empty = (status = 204) => new Response(null, { status });

export const signIn = (token = "id-token-1", expiresIn = "3600") =>
	json({ idToken: token, refreshToken: "refresh-1", expiresIn });

export const refreshed = (token = "id-token-2", expiresIn = "3600") =>
	json({ id_token: token, refresh_token: "refresh-2", expires_in: expiresIn });

export const live = {
	databaseURL: "https://demo-project-default-rtdb.firebaseio.com",
	apiKey: "api-key-123",
	email: "worker@example.com",
	password: "s3cret-password",
};

/** Resolves when the request's signal aborts, then rejects like fetch does. */
export const hang: Handler = ({ init }) =>
	new Promise((_, reject) => {
		init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
	});
