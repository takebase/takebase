// Error envelope returned by every Takebase Worker for a non-2xx response.
// The SDK maps it to a typed error; clients never parse ad-hoc error bodies.

export const errorCodes = [
	"bad_request",
	"validation_failed",
	"unauthenticated",
	"forbidden",
	"not_found",
	"conflict",
	"rate_limited",
	"internal",
	"unavailable",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export const errorStatus: Record<ErrorCode, number> = {
	bad_request: 400,
	validation_failed: 422,
	unauthenticated: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	rate_limited: 429,
	internal: 500,
	// A dependency the server needs (such as the global Worker) could not answer.
	unavailable: 503,
};

// Field-level messages for `validation_failed`, keyed by field name.
export type FieldErrors = Record<string, string>;

export type ErrorBody = {
	code: ErrorCode;
	message: string;
	fields?: FieldErrors;
};

export type ErrorEnvelope = { error: ErrorBody };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export const isErrorCode = (value: unknown): value is ErrorCode =>
	typeof value === "string" && (errorCodes as readonly string[]).includes(value);

export const isErrorEnvelope = (value: unknown): value is ErrorEnvelope => {
	if (!isRecord(value) || !isRecord(value.error)) return false;
	const { code, message, fields } = value.error;
	if (!isErrorCode(code) || typeof message !== "string") return false;
	return fields === undefined || isRecord(fields);
};
