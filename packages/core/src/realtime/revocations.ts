import type { RealtimeAdapter } from "./adapter.ts";

// Tenant-wide realtime revocations recorded in global D1 (tenant disabled).
// The global Worker's RPC surface, as tenant Workers call it.
export type RevocationSource = {
	// The revision to revoke every grant at, or null when nothing is owed.
	pendingRevocation: (tenantId: string) => Promise<number | null>;
	confirmRevocation: (tenantId: string, rev: number) => Promise<void>;
};

export type ReconcileResult = { revoked: number | null };

// Delivers the tenant's pending revocation: confirmed only after the realtime
// service accepted it, so a failure leaves it pending for the next attempt.
// Repeating it is harmless: the adapter keeps the newest revocation.
export const reconcileRevocation = async (
	source: RevocationSource,
	adapter: RealtimeAdapter,
	tenantId: string,
): Promise<ReconcileResult> => {
	const rev = await source.pendingRevocation(tenantId);
	if (rev === null) return { revoked: null };
	await adapter.revokeAll(rev);
	await source.confirmRevocation(tenantId, rev);
	return { revoked: rev };
};
