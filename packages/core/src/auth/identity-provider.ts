// Identity adapters, like Laravel's guard drivers (`Auth::extend`): each one
// turns a bearer token into a verified identity. Firebase is the first adapter;
// everything above this interface (memberships, the tenant guard, the global
// Worker's RPC) depends only on it.

// `subject` is the provider's stable user id (a Firebase uid). Memberships key
// on provider and subject together, so adapters can never collide. `authTime`
// is when the user signed in (Unix seconds); revoking sessions refuses every
// token from a sign-in before that moment.
export type VerifiedIdentity = { provider: string; subject: string; authTime: number };

export type IdentityProvider = {
	name: string;
	// Resolves only for a token it fully checked; anything else throws InvalidTokenError.
	verify: (token: string, now: Date) => Promise<VerifiedIdentity>;
};

export class InvalidTokenError extends Error {
	constructor(reason: string) {
		super(`Invalid token: ${reason}`);
		this.name = "InvalidTokenError";
	}
}

const bearerPattern = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

// `null` when no Authorization header was sent; a header that is present but
// not a well-formed bearer token is an invalid token, never an anonymous caller.
export const readBearerToken = (authorization: string | null | undefined) => {
	if (authorization === null || authorization === undefined || authorization === "") return null;
	const match = bearerPattern.exec(authorization);
	if (!match?.[1]) throw new InvalidTokenError("malformed Authorization header");
	return match[1];
};

// Laravel's `$request->user()` for one header: null when anonymous.
export const authenticate = async (provider: IdentityProvider, authorization: string | null | undefined, now: Date) => {
	const token = readBearerToken(authorization);
	return token === null ? null : provider.verify(token, now);
};
