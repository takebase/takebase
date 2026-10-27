// The CLI's copy of the Workers' log redaction (packages/core/src/diagnostics/log.ts):
// the CLI has no runtime dependencies and never imports @takebase/core.
// tests/security/log-redaction.test.ts runs the same fixtures through both
// copies, so they cannot drift apart. Used for everything `takebase logs` prints.

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
