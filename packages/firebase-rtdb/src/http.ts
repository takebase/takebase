import { FirebaseRtdbError, fail } from "./errors.ts";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const NO_VALUE = Symbol("no value");

/** Combines the per-request timeout with an optional caller signal. */
const requestSignal = (timeoutMs: number, caller?: AbortSignal): AbortSignal => {
	const timeout = AbortSignal.timeout(timeoutMs);
	return caller ? AbortSignal.any([caller, timeout]) : timeout;
};

/** Maps a thrown fetch/stream error to a fixed, content-free error. */
const transportError = (error: unknown, signal: AbortSignal, caller?: AbortSignal): FirebaseRtdbError => {
	if (error instanceof FirebaseRtdbError) return error;
	if (caller?.aborted) return fail("aborted");
	if (signal.aborted) return fail("timeout");
	return fail("connection_failed");
};

/**
 * Settles with the promise, or rejects with the signal's reason as soon as it
 * aborts. Guards against a fetch or body stream that ignores its signal.
 */
const abortable = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
};

/** Releases an unread body so Workers and undici can reuse the connection. */
const discard = (response: Response): void => {
	response.body?.cancel().catch(() => {});
};

const concat = (chunks: Uint8Array[], total: number): Uint8Array => {
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
};

/**
 * Reads at most maxBytes of the body; returns null when the body is larger.
 * An aborted signal cancels the stream and rejects, even if the body stalls.
 */
const readLimited = async (response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> => {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		discard(response);
		return null;
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const cancel = () => {
		reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await abortable(reader.read(), signal);
			if (done) return concat(chunks, total);
			total += value.byteLength;
			if (total > maxBytes) {
				cancel();
				return null;
			}
			chunks.push(value);
		}
	} finally {
		signal.removeEventListener("abort", cancel);
	}
};

/** Strict UTF-8 JSON decoding; returns NO_VALUE on any failure. */
const parseJson = (bytes: Uint8Array): unknown => {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		return NO_VALUE;
	}
};

const isParsed = (value: unknown): boolean => value !== NO_VALUE;

export type { Fetch };
export { abortable, discard, isParsed, parseJson, readLimited, requestSignal, transportError };
