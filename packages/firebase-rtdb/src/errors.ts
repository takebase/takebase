/**
 * Every failure is a FirebaseRtdbError with a fixed code and a fixed message.
 * Messages never contain URLs, paths, tokens, credentials or response bodies.
 */
type FirebaseRtdbErrorCode =
	| "invalid_options"
	| "invalid_path"
	| "invalid_value"
	| "closed"
	| "aborted"
	| "timeout"
	| "auth_rejected"
	| "auth_unavailable"
	| "denied"
	| "conflict"
	| "connection_failed"
	| "unavailable"
	| "request_failed"
	| "invalid_response";

const messages: Readonly<Record<FirebaseRtdbErrorCode, string>> = Object.freeze({
	invalid_options: "invalid client options",
	invalid_path: "database path must be one or more valid Firebase keys separated by '/'",
	invalid_value: "database value cannot be encoded as JSON",
	closed: "firebase client is closed",
	aborted: "database request aborted by caller",
	timeout: "database request timed out",
	auth_rejected: "firebase authentication rejected; check credentials and Email/Password provider",
	auth_unavailable: "firebase authentication temporarily unavailable",
	denied: "database request denied; check the user's database rules",
	conflict: "database value changed since it was read",
	connection_failed: "database connection failed",
	unavailable: "database temporarily unavailable",
	request_failed: "database request failed",
	invalid_response: "invalid database response",
});

// A class is required here: callers rely on `instanceof` and Error stack traces.
class FirebaseRtdbError extends Error {
	readonly code: FirebaseRtdbErrorCode;

	constructor(code: FirebaseRtdbErrorCode, message: string = messages[code]) {
		super(message);
		this.name = "FirebaseRtdbError";
		this.code = code;
	}
}

const fail = (code: FirebaseRtdbErrorCode, message?: string): FirebaseRtdbError => new FirebaseRtdbError(code, message);

// Failures worth retrying later with the same request: the service or network
// was briefly unavailable. Everything else needs a different request or config.
const retryableCodes: ReadonlySet<FirebaseRtdbErrorCode> = new Set([
	"timeout",
	"connection_failed",
	"unavailable",
	"auth_unavailable",
]);

const isRetryable = (error: unknown): boolean => error instanceof FirebaseRtdbError && retryableCodes.has(error.code);

export type { FirebaseRtdbErrorCode };
export { FirebaseRtdbError, fail, isRetryable };
