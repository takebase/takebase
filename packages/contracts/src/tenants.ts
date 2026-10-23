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
