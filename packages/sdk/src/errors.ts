import { type ErrorCode, type FieldErrors, isErrorEnvelope } from "@takebase/contracts";

// Thrown for every failed Takebase request, whether the Worker sent an error
// envelope or the response could not be interpreted.
export class TakebaseError extends Error {
	readonly status: number;
	readonly code: ErrorCode;
	readonly fields: FieldErrors;

	constructor(status: number, code: ErrorCode, message: string, fields: FieldErrors = {}) {
		super(message);
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
		if (body === undefined) throw new TakebaseError(response.status, "internal", "Response body is not valid JSON");
		return body as Body;
	}
	if (isErrorEnvelope(body)) {
		const { code, message, fields } = body.error;
		throw new TakebaseError(response.status, code, message, fields);
	}
	const code: ErrorCode = response.status >= 500 ? "internal" : "bad_request";
	throw new TakebaseError(response.status, code, `Request failed with status ${response.status}`);
};
