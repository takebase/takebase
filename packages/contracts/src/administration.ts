import type { TenantRole, TenantSummary } from "./tenants.ts";

// Tenant administration through the global Worker
// (`/api/admin/tenants/{id}/…`), open only to a holder of the tenant's
// built-in `admin` role, and invitation redemption (`POST /api/invites/redeem`).

export type AdminMember = { uid: string; roles: TenantRole[] };

export type AdminRole = { name: TenantRole; members: number };

export type AdminInviteState = "pending" | "redeemed" | "revoked" | "expired";

export type AdminInvite = { id: string; role: TenantRole; state: AdminInviteState; expires: string };

// Returned once, when the invitation is created: only its hash is stored.
export type CreatedInvite = { id: string; role: TenantRole; expires: string; token: string };

// A removal ends realtime access too: POST `reconcile` (it carries no
// authority) to deliver the revocation now rather than on the next session.
export type MemberRemoval = { reconcile: string };

export type InviteRedemption = { tenant: TenantSummary; role: TenantRole };

export const isInviteRedemption = (value: unknown): value is InviteRedemption => {
	if (typeof value !== "object" || value === null) return false;
	const { tenant, role } = value as Record<string, unknown>;
	if (typeof tenant !== "object" || tenant === null || typeof role !== "string") return false;
	const { id, name, url } = tenant as Record<string, unknown>;
	return typeof id === "string" && typeof name === "string" && typeof url === "string";
};
