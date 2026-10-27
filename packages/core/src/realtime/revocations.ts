import type { RealtimeAdapter } from "./adapter.ts";

// Realtime revocations recorded in global D1: tenant-wide (tenant disabled)
// and per user (removed from the tenant, disabled, or sessions revoked).
// The global Worker's RPC surface, as tenant Workers call it.
export type MemberRevocation = { provider: string; subject: string; rev: number };

export type RevocationSource = {
	// The revision to revoke every grant at, or null when nothing is owed.
	pendingRevocation: (tenantId: string) => Promise<number | null>;
	confirmRevocation: (tenantId: string, rev: number) => Promise<void>;
	// Users owed a revocation in this tenant, each at their newest pending revision.
	pendingMemberRevocations: (tenantId: string) => Promise<MemberRevocation[]>;
	confirmMemberRevocation: (tenantId: string, revocation: MemberRevocation) => Promise<void>;
};

export type ReconcileResult = { revoked: number | null; members: number };

// Delivers what the tenant owes: each revocation is confirmed only after the
// realtime service accepted it, so a failure leaves it (and the rest) pending
// for the next attempt. Repeating it is harmless: the adapter keeps the newest
// revocation, and a later grant at a newer revision still wins.
export const reconcileRevocation = async (
	source: RevocationSource,
	adapter: RealtimeAdapter,
	tenantId: string,
): Promise<ReconcileResult> => {
	const rev = await source.pendingRevocation(tenantId);
	if (rev !== null) {
		await adapter.revokeAll(rev);
		await source.confirmRevocation(tenantId, rev);
	}
	const members = await source.pendingMemberRevocations(tenantId);
	for (const member of members) {
		await adapter.revoke(member.subject, member.rev);
		await source.confirmMemberRevocation(tenantId, member);
	}
	return { revoked: rev, members: members.length };
};
