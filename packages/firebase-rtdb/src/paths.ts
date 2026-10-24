/** The only non-Firebase database URL accepted: the fixed local demo emulator. */
const EMULATOR_URL = "http://127.0.0.1:9000";

/** The only accepted Auth emulator origin, used to sign in to the database emulator as a real user. */
const AUTH_EMULATOR_URL = "http://127.0.0.1:9099";

/** Emulator database name (its ?ns= value) used when none is configured. */
const DEFAULT_EMULATOR_NAMESPACE = "demo-takebase-default-rtdb";

const MAX_KEY_BYTES = 768;
const FORBIDDEN_KEY_CHARS = ".#$[]/";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const encoder = new TextEncoder();

const isFirebaseHost = (host: string): boolean => {
	const normalized = host.toLowerCase().replace(/\.$/, "");
	return ["firebaseio.com", "firebasedatabase.app"].some(
		(suffix) => normalized.endsWith(`.${suffix}`) && normalized.length > suffix.length + 1,
	);
};

/**
 * Returns the normalized origin of an HTTPS Firebase database URL, or null.
 * Credentials, ports, query, fragment and any path other than "/" are rejected.
 */
const parseLiveOrigin = (raw: string): string | null => {
	if (raw !== raw.trim() || !/^https:\/\//i.test(raw)) return null;
	// URL drops a default :443, so reject any explicit port before parsing.
	const authority = raw.slice("https://".length).split(/[/?#]/, 1)[0] ?? "";
	if (authority.includes(":") || authority.includes("@")) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (
		url.protocol !== "https:" ||
		!url.hostname ||
		url.username ||
		url.password ||
		url.port ||
		raw.includes("?") ||
		raw.includes("#") ||
		url.pathname !== "/" ||
		!isFirebaseHost(url.hostname)
	) {
		return null;
	}
	return url.origin;
};

/** A single Firebase key: non-empty, at most 768 UTF-8 bytes, no controls or . # $ [ ] / */
const isValidKey = (key: string): boolean => {
	if (
		typeof key !== "string" ||
		key === "" ||
		LONE_SURROGATE.test(key) ||
		encoder.encode(key).byteLength > MAX_KEY_BYTES
	) {
		return false;
	}
	for (const char of key) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f || FORBIDDEN_KEY_CHARS.includes(char)) return false;
	}
	return true;
};

/** Trims surrounding slashes and requires one or more valid Firebase keys. */
const cleanPath = (path: string): string | null => {
	if (typeof path !== "string") return null;
	const trimmed = path.replace(/^\/+|\/+$/g, "");
	return trimmed.split("/").every(isValidKey) ? trimmed : null;
};

export {
	AUTH_EMULATOR_URL,
	cleanPath,
	DEFAULT_EMULATOR_NAMESPACE,
	EMULATOR_URL,
	isFirebaseHost,
	isValidKey,
	parseLiveOrigin,
};
