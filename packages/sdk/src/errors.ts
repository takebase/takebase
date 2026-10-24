import { type ErrorCode, type FieldErrors, isErrorEnvelope } from "@takebase/contracts";

// Failures that happen in the client, without an error envelope from a Worker:
// the request never got a response, was aborted, the response was unusable, or
// the handle's tenant or user changed before the request was sent.
export type ClientErrorCode = "network" | "aborted" | "invalid_response" | "tenant_changed";

export type TakebaseErrorCode = ErrorCode | ClientErrorCode;

// Thrown for every failed Takebase request, whether the Worker sent an error
// envelope or the response could not be interpreted. `status` is 0 when no
// HTTP response was received.
export class TakebaseError extends Error {
	readonly status: number;
	readonly code: TakebaseErrorCode;
	readonly fields: FieldErrors;

	constructor(
		status: number,
		code: TakebaseErrorCode,
		message: string,
		fields: FieldErrors = {},
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "TakebaseError";
		this.status = status;
		this.code = code;
		this.fields = fields;
	}
}

const readJson = async (response: Response): Promise<unknown> => {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
};

// Returns the parsed JSON body of a successful response, or throws a TakebaseError.
export const readResponse = async <Body>(response: Response): Promise<Body> => {
	const body = await readJson(response);
	if (response.ok) {
		if (body === undefined)
			throw new TakebaseError(response.status, "invalid_response", "Response body is not valid JSON");
		return body as Body;
	}
	if (isErrorEnvelope(body)) {
		const { code, message, fields } = body.error;
		throw new TakebaseError(response.status, code, message, fields);
	}
	const code: ErrorCode = response.status >= 500 ? "internal" : "bad_request";
	throw new TakebaseError(response.status, code, `Request failed with status ${response.status}`);
};
