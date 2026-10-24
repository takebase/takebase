import { fail } from "./errors.ts";
import { abortable, discard, type Fetch, isParsed, parseJson, readLimited } from "./http.ts";

/** Where sign-in and refresh go: Google's Auth APIs, or the local Auth emulator. */
type AuthEndpoints = Readonly<{ signIn: string; refresh: string }>;

const GOOGLE_AUTH: AuthEndpoints = Object.freeze({
	signIn: "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
	refresh: "https://securetoken.googleapis.com/v1/token",
});

/** The Auth emulator serves the same APIs under its own origin. */
const emulatorAuth = (origin: string): AuthEndpoints =>
	Object.freeze({
		signIn: `${origin}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`,
		refresh: `${origin}/securetoken.googleapis.com/v1/token`,
	});
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
const EXPIRY_MARGIN_MS = 30_000;

type Tokens = { token: string; refresh: string; lifetimeMs: number };

type PasswordTokens = Readonly<{
	token: (signal: AbortSignal) => Promise<string>;
	/** Forces the next token() call to refresh, for example after a 401. */
	invalidate: () => void;
	close: () => void;
}>;

/** Accepts both the Identity Toolkit (camelCase) and Secure Token (snake_case) shapes. */
const decodeTokens = (value: unknown): Tokens | null => {
	if (!isParsed(value) || typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const fields = value as Record<string, unknown>;
	const read = (camel: string, snake: string): string => {
		const field = fields[camel] ?? fields[snake];
		return typeof field === "string" ? field : "";
	};
	const token = read("idToken", "id_token");
	const refresh = read("refreshToken", "refresh_token");
	const expiresIn = read("expiresIn", "expires_in");
	const seconds = /^\d{1,6}$/.test(expiresIn) ? Number(expiresIn) : 0;
	if (seconds <= 30 || seconds > 86_400 || !token || !refresh || /[\r\n\0]/.test(token)) return null;
	return { token, refresh, lifetimeMs: seconds * 1000 };
};

/**
 * Email/password ID tokens with fixed endpoints, bounded responses, cached
 * tokens and content-free errors. Concurrent callers share one sign-in or
 * refresh. After the first sign-in only the refresh token is kept.
 * Credentials and tokens live only in this closure, so they never appear in
 * console.log, JSON.stringify or object spreads of the returned object.
 */
const createPasswordTokens = (
	endpoints: AuthEndpoints,
	apiKey: string,
	email: string,
	password: string,
	fetch: Fetch,
	timeoutMs: number,
	now: () => number,
): PasswordTokens => {
	let token = "";
	let refresh = "";
	let expiresAt = 0;
	let pending: Promise<string> | null = null;
	let closed = false;

	const authenticate = async (): Promise<string> => {
		const refreshing = refresh !== "";
		const endpoint = `${refreshing ? endpoints.refresh : endpoints.signIn}?key=${encodeURIComponent(apiKey)}`;
		const init: RequestInit = refreshing
			? {
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }).toString(),
				}
			: {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ email, password, returnSecureToken: true }),
				};
		const signal = AbortSignal.timeout(timeoutMs);
		let response: Response;
		try {
			response = await abortable(fetch(endpoint, { ...init, method: "POST", redirect: "manual", signal }), signal);
		} catch {
			throw fail("auth_unavailable");
		}
		if (response.status !== 200) {
			discard(response);
			if (response.status === 408 || response.status === 429 || response.status >= 500) throw fail("auth_unavailable");
			throw fail("auth_rejected");
		}
		let tokens: Tokens | null;
		try {
			const bytes = await readLimited(response, MAX_AUTH_RESPONSE_BYTES, signal);
			tokens = bytes === null ? null : decodeTokens(parseJson(bytes));
		} catch {
			throw fail("auth_unavailable");
		}
		if (!tokens) throw fail("auth_unavailable", "invalid Firebase authentication response");
		if (closed) throw fail("closed");
		token = tokens.token;
		refresh = tokens.refresh;
		expiresAt = now() + tokens.lifetimeMs;
		password = "";
		return token;
	};

	const getToken = async (signal: AbortSignal): Promise<string> => {
		if (closed) throw fail("closed");
		if (token && now() + EXPIRY_MARGIN_MS < expiresAt) return token;
		// The shared request has its own timeout, so one caller aborting does not fail the others.
		pending ??= authenticate().finally(() => {
			pending = null;
		});
		return abortable(pending, signal);
	};

	const invalidate = (): void => {
		expiresAt = 0;
	};

	const close = (): void => {
		closed = true;
		password = "";
		token = "";
		refresh = "";
		expiresAt = 0;
	};

	return Object.freeze({ token: getToken, invalidate, close });
};

export type { AuthEndpoints, PasswordTokens };
export { createPasswordTokens, emulatorAuth, GOOGLE_AUTH };
