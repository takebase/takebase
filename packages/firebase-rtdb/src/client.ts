import { createPasswordTokens, emulatorAuth, GOOGLE_AUTH, type PasswordTokens } from "./auth.ts";
import { fail } from "./errors.ts";
import {
	abortable,
	discard,
	type Fetch,
	isParsed,
	parseJson,
	readLimited,
	requestSignal,
	transportError,
} from "./http.ts";
import {
	AUTH_EMULATOR_URL,
	cleanPath,
	DEFAULT_EMULATOR_NAMESPACE,
	EMULATOR_URL,
	isValidKey,
	parseLiveOrigin,
} from "./paths.ts";

type ClientOptions = {
	/** EMULATOR_URL selects the local emulator; anything else must be an HTTPS Firebase origin. */
	databaseURL: string;
	/** Required for Firebase. With the emulator, only used to sign in through `authEmulatorURL`. */
	apiKey?: string;
	email?: string;
	password?: string;
	/** Emulator database name (its ?ns= value). Ignored for Firebase. */
	emulatorNamespace?: string;
	/**
	 * Emulator only: AUTH_EMULATOR_URL makes the client sign in as `email` through
	 * the Auth emulator, so the database rules apply exactly as in production.
	 * Without it the emulator client uses the admin `owner` token, for test setup.
	 */
	authEmulatorURL?: string;
	/** Budget for each request, including sign-in and the response body. Default 10 seconds. */
	timeoutMs?: number;
	/** Largest accepted response body. Default 16 MiB. */
	maxResponseBytes?: number;
	/** Injected fetch, for tests. Defaults to the global fetch. */
	fetch?: Fetch;
};

type RequestOptions = {
	/** Aborts this request; reported as code "aborted". */
	signal?: AbortSignal;
};

type Mode = "live" | "emulator";

/** A value and the ETag that identifies it, for a later conditional write. */
type Versioned<T> = { value: T; etag: string };

type FirebaseClient = Readonly<{
	mode: Mode;
	/** Reads the JSON value at path; null when nothing is stored there. */
	get: <T = unknown>(path: string, options?: RequestOptions) => Promise<T>;
	/** Reads the value at path together with its ETag. */
	getWithETag: <T = unknown>(path: string, options?: RequestOptions) => Promise<Versioned<T>>;
	/** Replaces the value at path. */
	set: (path: string, value: unknown, options?: RequestOptions) => Promise<void>;
	/** Replaces the value at path only if its ETag still matches; otherwise fails with "conflict". */
	setIfUnchanged: (path: string, value: unknown, etag: string, options?: RequestOptions) => Promise<void>;
	/** Merges fields into the value at path; field names may be nested "a/b" paths. */
	update: (path: string, fields: Record<string, unknown>, options?: RequestOptions) => Promise<void>;
	/** Adds value under a new server-generated key at path and returns the key. */
	push: (path: string, value: unknown, options?: RequestOptions) => Promise<string>;
	/** Removes the value at path. */
	delete: (path: string, options?: RequestOptions) => Promise<void>;
	/** Forgets cached credentials and tokens; later calls fail with code "closed". */
	close: () => void;
}>;

type Expect = "none" | "json";
type Target = { origin: string; namespace: string; tokens: PasswordTokens | null; mode: Mode };
type Conditional = { etag?: "read" | string };
type Reply = { value: unknown; etag: string | null };

/** Firebase server-side timestamp placeholder, resolved when the write is applied. */
const SERVER_TIMESTAMP: Readonly<{ ".sv": "timestamp" }> = Object.freeze({ ".sv": "timestamp" });

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

const credential = (value: unknown): value is string =>
	typeof value === "string" && value !== "" && !/[\r\n\0]/.test(value);

const isEtag = (value: unknown): value is string =>
	typeof value === "string" && value !== "" && value.length <= 256 && !/[\r\n\0]/.test(value);

// Statuses that mean "try again later": throttling and server-side failures.
const isUnavailable = (status: number) => status === 408 || status === 429 || status >= 500;

const resolveTarget = (options: ClientOptions, fetch: Fetch, timeoutMs: number): Target => {
	const { databaseURL, apiKey, email, password } = options;
	if (typeof databaseURL === "string" && databaseURL.replace(/\/$/, "") === EMULATOR_URL) {
		const namespace = options.emulatorNamespace || DEFAULT_EMULATOR_NAMESPACE;
		if (!isValidKey(namespace)) throw fail("invalid_options", "emulator namespace must be a valid Firebase key");
		if (options.authEmulatorURL === undefined)
			return { origin: EMULATOR_URL, namespace, tokens: null, mode: "emulator" };
		if (options.authEmulatorURL.replace(/\/$/, "") !== AUTH_EMULATOR_URL) {
			throw fail("invalid_options", "auth emulator URL must be the local Auth emulator");
		}
		if (!credential(email) || !credential(password)) {
			throw fail("invalid_options", "email and password are required to sign in through the Auth emulator");
		}
		// The Auth emulator accepts any API key.
		const key = credential(apiKey) ? apiKey : "demo-api-key";
		const tokens = createPasswordTokens(emulatorAuth(AUTH_EMULATOR_URL), key, email, password, fetch, timeoutMs, () =>
			Date.now(),
		);
		return { origin: EMULATOR_URL, namespace, tokens, mode: "emulator" };
	}
	if (options.authEmulatorURL !== undefined) {
		throw fail("invalid_options", "the Auth emulator can only be used with the database emulator");
	}
	const origin = typeof databaseURL === "string" ? parseLiveOrigin(databaseURL) : null;
	if (!origin) {
		throw fail("invalid_options", "database URL must be an HTTPS Firebase origin or the local emulator URL");
	}
	if (!credential(apiKey) || !credential(email) || !credential(password)) {
		throw fail("invalid_options", "apiKey, email and password are required for a Firebase database");
	}
	const tokens = createPasswordTokens(GOOGLE_AUTH, apiKey, email, password, fetch, timeoutMs, () => Date.now());
	return { origin, namespace: "", tokens, mode: "live" };
};

/**
 * REST-only Firebase Realtime Database client: read and write any path with any
 * JSON. It knows nothing about the data it carries. Redirects are never
 * followed; errors never contain response bodies, URLs or credentials.
 * Sign-in happens on the first request and tokens are cached in the client.
 */
const createClient = (options: ClientOptions): FirebaseClient => {
	const { timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = options;
	if (!positiveInteger(timeoutMs) || !positiveInteger(maxResponseBytes)) {
		throw fail("invalid_options", "timeoutMs and maxResponseBytes must be positive integers");
	}
	const fetch: Fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const { origin, namespace, tokens, mode } = resolveTarget(options, fetch, timeoutMs);
	let closed = false;

	const rest = async (
		method: string,
		path: string,
		value: unknown,
		expect: Expect,
		request?: RequestOptions,
		conditional: Conditional = {},
	): Promise<Reply> => {
		if (closed) throw fail("closed");
		const clean = cleanPath(path);
		if (clean === null) throw fail("invalid_path");
		let body: string | undefined;
		if (method !== "GET" && method !== "DELETE") {
			try {
				body = JSON.stringify(value);
			} catch {
				body = undefined;
			}
			if (body === undefined) throw fail("invalid_value");
		}
		const caller = request?.signal;
		const signal = requestSignal(timeoutMs, caller);
		try {
			const target = new URL(origin);
			target.pathname = `/${clean.split("/").map(encodeURIComponent).join("/")}.json`;
			const headers: Record<string, string> = {};
			if (mode === "emulator") target.searchParams.set("ns", namespace);
			if (tokens) target.searchParams.set("auth", await tokens.token(signal));
			else headers.Authorization = "Bearer owner";
			if (expect === "none") target.searchParams.set("print", "silent");
			if (body !== undefined) headers["Content-Type"] = "application/json";
			if (conditional.etag === "read") headers["X-Firebase-ETag"] = "true";
			else if (conditional.etag !== undefined) headers["if-match"] = conditional.etag;
			const response = await abortable(
				fetch(target.toString(), { method, headers, body, redirect: "manual", signal }),
				signal,
			);
			if (response.status === 401 || response.status === 403) {
				discard(response);
				tokens?.invalidate();
				throw fail("denied");
			}
			if (response.status === 412 && conditional.etag !== undefined && conditional.etag !== "read") {
				discard(response);
				throw fail("conflict");
			}
			const etag = response.headers.get("etag");
			if (expect === "none" && response.status === 204) {
				discard(response);
				return { value: undefined, etag };
			}
			if (expect === "json" && response.status === 200) {
				const bytes = await readLimited(response, maxResponseBytes, signal);
				const parsed = bytes === null ? undefined : parseJson(bytes);
				if (bytes === null || !isParsed(parsed)) throw fail("invalid_response");
				return { value: parsed, etag };
			}
			discard(response);
			throw fail(isUnavailable(response.status) ? "unavailable" : "request_failed");
		} catch (error) {
			throw transportError(error, signal, caller);
		}
	};

	const get = async <T = unknown>(path: string, request?: RequestOptions): Promise<T> =>
		(await rest("GET", path, undefined, "json", request)).value as T;

	const getWithETag = async <T = unknown>(path: string, request?: RequestOptions): Promise<Versioned<T>> => {
		const { value, etag } = await rest("GET", path, undefined, "json", request, { etag: "read" });
		if (!isEtag(etag)) throw fail("invalid_response");
		return { value: value as T, etag };
	};

	const set = async (path: string, value: unknown, request?: RequestOptions): Promise<void> => {
		await rest("PUT", path, value, "none", request);
	};

	// Firebase answers a conditional write with the stored value, so print=silent is not used.
	const setIfUnchanged = async (path: string, value: unknown, etag: string, request?: RequestOptions) => {
		if (!isEtag(etag)) throw fail("invalid_value");
		await rest("PUT", path, value, "json", request, { etag });
	};

	const update = async (path: string, fields: Record<string, unknown>, request?: RequestOptions): Promise<void> => {
		if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw fail("invalid_value");
		await rest("PATCH", path, fields, "none", request);
	};

	const push = async (path: string, value: unknown, request?: RequestOptions): Promise<string> => {
		const { value: created } = await rest("POST", path, value, "json", request);
		const name = typeof created === "object" && created !== null ? (created as { name?: unknown }).name : undefined;
		if (typeof name !== "string" || !isValidKey(name)) throw fail("invalid_response");
		return name;
	};

	const remove = async (path: string, request?: RequestOptions): Promise<void> => {
		await rest("DELETE", path, undefined, "none", request);
	};

	const close = (): void => {
		closed = true;
		tokens?.close();
	};

	return Object.freeze({ mode, get, getWithETag, set, setIfUnchanged, update, push, delete: remove, close });
};

export type { ClientOptions, FirebaseClient, Mode, RequestOptions, Versioned };
export { createClient, SERVER_TIMESTAMP };
