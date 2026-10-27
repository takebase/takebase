import { type ErrorCode, errorStatus } from "@takebase/contracts";
import type { AuthIdentity } from "../rules/types.ts";
import { ensureAccepted } from "../services/identities-d1-service.ts";
import { createMembershipsService } from "../services/memberships-d1-service.ts";
import type { AnyD1Database } from "../storage/d1.ts";
import { type IdentityProvider, InvalidTokenError, readBearerToken } from "./identity-provider.ts";

// The trusted boundary between tenant Workers and the global Worker. A tenant
// Worker forwards the caller's bearer token over its service binding; the
// global Worker verifies it and reads the membership from global D1. The tenant
// never trusts a client-supplied uid, role, tenant or URL.

// `revision` is the tenant's access revision read with the answer (see
// tenants.access_revision): realtime grants and revocations are versioned with
// it. `subject` on not_member names the verified user whose access to revoke.
export type MembershipCheck =
	| { status: "member"; identity: AuthIdentity; revision: number }
	| { status: "invalid_token" }
	| { status: "not_member"; subject: string; revision: number | null };

// The global Worker's RPC surface, as tenant Workers call it.
export type MembershipVerifier = {
	verifyMembership: (token: string, tenantId: string) => Promise<MembershipCheck>;
};

export type MembershipCheckContext = { identity: IdentityProvider; db: AnyD1Database; now: Date };

// Global side: verify the token, check Takebase still accepts the identity
// (not disabled, sessions not revoked), then read the membership; no cache.
export const checkMembership = async (
	{ identity, db, now }: MembershipCheckContext,
	token: unknown,
	tenantId: unknown,
): Promise<MembershipCheck> => {
	if (typeof token !== "string" || typeof tenantId !== "string") return { status: "invalid_token" };
	let verified: Awaited<ReturnType<IdentityProvider["verify"]>>;
	try {
		verified = await ensureAccepted(db, await identity.verify(token, now));
	} catch (error) {
		if (error instanceof InvalidTokenError) return { status: "invalid_token" };
		throw error;
	}
	const { roles, revision } = await createMembershipsService(db).access(verified, tenantId);
	if (roles === null || revision === null) return { status: "not_member", subject: verified.subject, revision };
	return { status: "member", identity: { id: verified.subject, provider: verified.provider, roles }, revision };
};

export class AuthError extends Error {
	readonly code: Extract<ErrorCode, "unauthenticated" | "forbidden" | "unavailable">;
	constructor(code: AuthError["code"], message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AuthError";
		this.code = code;
	}

	get status() {
		return errorStatus[this.code] as 401 | 403 | 503;
	}
}

// What the tenant guard learns from one membership check.
export type TenantMember = { identity: AuthIdentity; revision: number };

export type AuthenticateOptions = {
	// Called when the global Worker says the verified caller is not a member, so
	// the tenant can revoke any realtime access they still hold.
	notMember?: (subject: string, revision: number) => void;
};

// Tenant side: Laravel's `auth` middleware plus an EnsureTenantMember check.
// No Authorization header → anonymous (rules decide). Otherwise the caller is
// a verified member of this tenant or the request stops here. If the global
// Worker cannot answer, nobody is authenticated: the request fails with 503.
export const authenticateTenantMember = async (
	verifier: MembershipVerifier,
	tenantId: string,
	authorization: string | null | undefined,
	{ notMember }: AuthenticateOptions = {},
): Promise<TenantMember | null> => {
	let token: string | null;
	try {
		token = readBearerToken(authorization);
	} catch {
		throw new AuthError("unauthenticated", "Invalid or expired token");
	}
	if (token === null) return null;

	let check: MembershipCheck;
	try {
		check = await verifier.verifyMembership(token, tenantId);
	} catch (error) {
		throw new AuthError("unavailable", "Membership could not be verified", { cause: error });
	}
	switch (check?.status) {
		case "member":
			return { identity: check.identity, revision: check.revision };
		case "invalid_token":
			throw new AuthError("unauthenticated", "Invalid or expired token");
		case "not_member":
			if (typeof check.subject === "string" && typeof check.revision === "number") {
				notMember?.(check.subject, check.revision);
			}
			throw new AuthError("forbidden", "Not a member of this tenant");
		default:
			throw new AuthError("unavailable", "Membership could not be verified");
	}
};
