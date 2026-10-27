import { redact, redactText } from "./redact.ts";

// Turns `wrangler tail --format json` output into short, redacted lines.
// Wrangler prints one JSON object per event, possibly across several lines and
// chunks. Only a fixed set of fields is ever printed: never request headers,
// query strings or bodies, and every logged value goes through the redactor.

type TailLog = { level?: unknown; message?: unknown; timestamp?: unknown };
type TailEvent = {
	outcome?: unknown;
	eventTimestamp?: unknown;
	event?: { request?: { url?: unknown; method?: unknown }; response?: { status?: unknown } } | null;
	logs?: TailLog[];
	exceptions?: { name?: unknown; message?: unknown }[];
};

const text = (value: unknown) => (typeof value === "string" ? value : "");

// The path only: the query string can carry tokens.
const pathOf = (url: unknown) => {
	try {
		return new URL(text(url)).pathname;
	} catch {
		return "-";
	}
};

const time = (value: unknown) => (typeof value === "number" ? new Date(value).toISOString() : "-");

// One logged message: a Takebase JSON log line keeps its structure (redacted
// again here), anything else is redacted as text.
const formatLog = (log: TailLog) => {
	const parts = Array.isArray(log.message) ? log.message : [log.message];
	const first = parts[0];
	if (parts.length === 1 && typeof first === "string" && first.startsWith("{")) {
		try {
			const { level, event, requestId, service, tenantId, ...fields } = JSON.parse(first) as Record<string, unknown>;
			const rest = JSON.stringify(redact(fields));
			return `  ${text(level) || text(log.level)} ${redactText(text(event))}${rest === "{}" ? "" : ` ${rest}`}`;
		} catch {}
	}
	const message = parts.map((part) => (typeof part === "string" ? part : JSON.stringify(redact(part)))).join(" ");
	return `  ${text(log.level) || "log"} ${redactText(message)}`;
};

// The request id the Worker logged for this event, if any.
const requestIdOf = (logs: TailLog[]) => {
	for (const log of logs) {
		const first = Array.isArray(log.message) ? log.message[0] : log.message;
		if (typeof first !== "string" || !first.startsWith("{")) continue;
		try {
			const { requestId } = JSON.parse(first) as { requestId?: unknown };
			if (typeof requestId === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(requestId)) return requestId;
		} catch {}
	}
	return "-";
};

// Masks every known secret value (the environment's secrets file), which no
// pattern can recognise inside free text such as an exception message.
const maskKnown = (line: string, secrets: readonly string[]) =>
	secrets.reduce((masked, secret) => masked.replaceAll(secret, "[redacted]"), line);

export const formatTailEvent = (event: TailEvent, secrets: readonly string[] = []) => {
	const logs = Array.isArray(event.logs) ? event.logs : [];
	const request = event.event?.request;
	const status = event.event?.response?.status;
	const head = [
		time(event.eventTimestamp),
		redactText(text(event.outcome) || "-"),
		redactText(text(request?.method) || "-"),
		redactText(pathOf(request?.url)),
		typeof status === "number" ? String(status) : "-",
		requestIdOf(logs),
	].join(" ");
	const lines = [head, ...logs.map(formatLog)];
	for (const exception of Array.isArray(event.exceptions) ? event.exceptions : []) {
		lines.push(`  exception ${redactText(`${text(exception.name)}: ${text(exception.message)}`)}`);
	}
	const known = secrets.filter((secret) => secret.length >= 6);
	return known.length === 0 ? lines : lines.map((line) => maskKnown(line, known));
};

// Splits a stream into top-level JSON objects (tracking strings and escapes),
// so an object spread over chunks is formatted once it is complete. Text
// outside objects (Wrangler's banners) is dropped.
export const createTailParser = (onEvent: (event: TailEvent) => void) => {
	let buffer = "";
	let depth = 0;
	let inString = false;
	let escaped = false;
	let start = -1;
	return (chunk: string) => {
		const offset = buffer.length;
		buffer += chunk;
		for (let index = offset; index < buffer.length; index++) {
			const char = buffer[index];
			if (inString) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') inString = false;
				continue;
			}
			if (char === '"' && depth > 0) inString = true;
			else if (char === "{") {
				if (depth === 0) start = index;
				depth++;
			} else if (char === "}" && depth > 0) {
				depth--;
				if (depth === 0) {
					try {
						onEvent(JSON.parse(buffer.slice(start, index + 1)) as TailEvent);
					} catch {}
					buffer = buffer.slice(index + 1);
					index = -1;
					start = -1;
				}
			}
		}
		if (depth === 0) buffer = "";
		// Never hold an unbounded partial event.
		if (buffer.length > 1_000_000) {
			buffer = "";
			depth = 0;
			inString = false;
		}
	};
};
