import { createRevocationsService } from "@takebase/core";
import { useContext } from "../request-store.ts";

// Realtime revocations, as tenant Workers fetch and confirm them over their
// service binding. The tenant id is the caller's own TENANT_ID.
export const pendingRevocation = (tenantId: unknown) => {
	if (typeof tenantId !== "string") return Promise.resolve(null);
	return createRevocationsService(useContext().db).pending(tenantId);
};

export const confirmRevocation = async (tenantId: unknown, rev: unknown) => {
	if (typeof tenantId !== "string" || typeof rev !== "number" || !Number.isInteger(rev)) {
		throw new TypeError("confirmRevocation needs a tenant id and an integer revision");
	}
	const { db, now } = useContext();
	await createRevocationsService(db).confirm(tenantId, rev, now);
};

export const pendingMemberRevocations = (tenantId: unknown) => {
	if (typeof tenantId !== "string") return Promise.resolve([]);
	return createRevocationsService(useContext().db).pendingMembers(tenantId);
};

export const confirmMemberRevocation = async (tenantId: unknown, revocation: unknown) => {
	const { provider, subject, rev } = (revocation ?? {}) as Record<string, unknown>;
	if (
		typeof tenantId !== "string" ||
		typeof provider !== "string" ||
		typeof subject !== "string" ||
		typeof rev !== "number" ||
		!Number.isInteger(rev)
	) {
		throw new TypeError("confirmMemberRevocation needs a tenant id, provider, subject and integer revision");
	}
	const { db, now } = useContext();
	await createRevocationsService(db).confirmMember(tenantId, provider, subject, rev, now);
};
