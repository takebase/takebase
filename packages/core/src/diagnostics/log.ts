// Structured, redacted logging for Workers. Each call writes one JSON line,
// which Workers Logs and `wrangler tail` keep as a structured event. Nothing
// here stores logs: Cloudflare's own log retention applies.
//
// Redaction is the last guard, not permission to log secrets: values under
// sensitive keys are dropped, and bearer tokens, JWT-shaped strings, sensitive
// URL parameters and email addresses are masked inside any string. Strings are
// bounded, and errors keep only their name and message (no stack, no cause).

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export type Logger = {
	info: (event: string, fields?: LogFields) => void;
	warn: (event: string, fields?: LogFields) => void;
	error: (event: string, fields?: LogFields) => void;
};

// Who wrote the line; set once per request by the Worker's composition root.
export type LogScope = { service: string; requestId?: string; tenantId?: string };

export const REDACTED = "[redacted]";
const maxString = 500;
const maxDepth = 4;
const maxItems = 20;

const sensitiveKey =
	/pass(word)?|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|credential|session|signature/i;

const textPatterns: [RegExp, string][] = [
	// Authorization header values.
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
	// JWT-shaped strings (Firebase ID tokens, custom tokens).
	[/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
	// Sensitive parameters, in URLs (the RTDB REST `?auth=`) or bare `name=value`.
	[
		/((?:^|[?&\s;,])(?:auth|token|access_token|id_token|refresh_token|key|api_key|apikey|password|secret|code)=)[^&#\s"',;]*/gi,
		`$1${REDACTED}`,
	],
	// Email addresses.
	[/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];

export const redactText = (text: string) => {
	let result = text;
	for (const [pattern, replacement] of textPatterns) result = result.replace(pattern, replacement);
	return result.length > maxString ? `${result.slice(0, maxString)}…` : result;
};

export const redact = (value: unknown, depth = 0): unknown => {
	if (typeof value === "string") return redactText(value);
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
	if (typeof value !== "object") return undefined;
	if (depth >= maxDepth) return "[nested]";
	if (Array.isArray(value)) return value.slice(0, maxItems).map((item) => redact(item, depth + 1));
	return Object.fromEntries(
		Object.entries(value)
			.slice(0, maxItems)
			.map(([key, item]) => [key, sensitiveKey.test(key) ? REDACTED : redact(item, depth + 1)]),
	);
};

const requestIdPattern = /^[A-Za-z0-9._-]{8,64}$/;

// The request's correlation id: a well-formed inbound `x-request-id`, else
// Cloudflare's `cf-ray`, else a fresh UUID. Anything else from the client is
// ignored, so a caller cannot inject unbounded text into every log line.
export const requestIdOf = (request?: Request) => {
	for (const header of ["x-request-id", "cf-ray"]) {
		const value = request?.headers.get(header);
		if (value && requestIdPattern.test(value)) return value;
	}
	return crypto.randomUUID();
};

const eventPattern = /^[a-z][a-z0-9_.-]{0,63}$/;

export const createLogger = (scope: LogScope): Logger => {
	const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
		// The scope comes last, so fields can never overwrite who wrote the line.
		const line = JSON.stringify({
			...(redact(fields) as LogFields),
			level,
			event: eventPattern.test(event) ? event : "invalid_event",
			...scope,
		});
		if (level === "error") console.error(line);
		else if (level === "warn") console.warn(line);
		else console.log(line);
	};
	return {
		info: (event, fields) => write("info", event, fields),
		warn: (event, fields) => write("warn", event, fields),
		error: (event, fields) => write("error", event, fields),
	};
};
