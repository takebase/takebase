import { and, eq } from "drizzle-orm";
import { InvalidTokenError, type VerifiedIdentity } from "../auth/identity-provider.ts";
import { type AnyD1Database, createDatabase } from "../storage/d1.ts";
import { identities } from "../tenancy/schema.ts";

// Takebase's own standing for a verified identity (global D1 `identities`).
// The provider still owns the account; this is what lets Takebase disable a
// user or revoke their sessions without the provider's admin API. Read on
// every request, with no cache.

export const createIdentitiesService = (d1: AnyD1Database) => {
	const db = createDatabase(d1);

	// False when the identity is disabled or deleted, or signed in no later than
	// its sessions were revoked. An identity Takebase never recorded is accepted.
	const accepts = async (identity: VerifiedIdentity) => {
		const [row] = await db
			.select({ status: identities.status, validAfter: identities.sessions_valid_after })
			.from(identities)
			.where(and(eq(identities.provider, identity.provider), eq(identities.subject, identity.subject)))
			.limit(1);
		if (!row) return true;
		if (row.status !== "active") return false;
		return row.validAfter === null || identity.authTime > row.validAfter;
	};

	return { accepts };
};

// A refused identity is treated like an invalid token: 401, which the SDK
// turns into a full sign-out.
export const ensureAccepted = async (d1: AnyD1Database, identity: VerifiedIdentity) => {
	if (!(await createIdentitiesService(d1).accepts(identity))) throw new InvalidTokenError("identity refused");
	return identity;
};
