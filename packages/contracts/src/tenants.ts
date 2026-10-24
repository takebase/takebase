// Tenant discovery returned by the global Worker. Roles are tenant-scoped and
// enforced by the tenant Worker; the client only uses them for display.

export type TenantRole = string;

export type TenantSummary = {
	id: string;
	name: string;
	// Base URL of the tenant Worker the SDK routes to after selection.
	url: string;
};

export type TenantMembership = {
	tenant: TenantSummary;
	roles: TenantRole[];
};

export type TenantListResponse = { tenants: TenantMembership[] };

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isMembership = (value: unknown): value is TenantMembership => {
	if (typeof value !== "object" || value === null) return false;
	const { tenant, roles } = value as Record<string, unknown>;
	if (typeof tenant !== "object" || tenant === null) return false;
	const { id, name, url } = tenant as Record<string, unknown>;
	return isText(id) && typeof name === "string" && isText(url) && Array.isArray(roles) && roles.every(isText);
};

export const isTenantListResponse = (value: unknown): value is TenantListResponse =>
	typeof value === "object" &&
	value !== null &&
	Array.isArray((value as Record<string, unknown>).tenants) &&
	((value as Record<string, unknown>).tenants as unknown[]).every(isMembership);
