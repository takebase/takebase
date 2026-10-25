import type { TenantMembership } from "@takebase/contracts";
import { and, asc, eq } from "drizzle-orm";
import type { VerifiedIdentity } from "../auth/identity-provider.ts";
import { type AnyD1Database, createDatabase } from "../storage/d1.ts";
import { memberships, tenants } from "../tenancy/schema.ts";

// All SQL for tenant memberships lives here. Every read is authoritative: there
// is no cache, so a removed member or a disabled tenant loses access on the
// next request.

export const createMembershipsService = (d1: AnyD1Database) => {
	const db = createDatabase(d1);

	const rows = (identity: VerifiedIdentity, tenantId?: string) =>
		db
			.select({ id: tenants.id, name: tenants.name, url: tenants.url, role: memberships.role })
			.from(memberships)
			.innerJoin(tenants, eq(tenants.id, memberships.tenant_id))
			.where(
				and(
					eq(memberships.provider, identity.provider),
					eq(memberships.subject, identity.subject),
					eq(tenants.status, "active"),
					tenantId === undefined ? undefined : eq(tenants.id, tenantId),
				),
			)
			.orderBy(asc(tenants.id), asc(memberships.role));

	// Active tenants the identity belongs to, with its roles in each.
	const list = async (identity: VerifiedIdentity): Promise<TenantMembership[]> => {
		const byTenant = new Map<string, TenantMembership>();
		for (const { id, name, url, role } of await rows(identity)) {
			const entry = byTenant.get(id) ?? { tenant: { id, name, url }, roles: [] };
			entry.roles.push(role);
			byTenant.set(id, entry);
		}
		return [...byTenant.values()];
	};

	// The identity's roles in one tenant together with that tenant's access
	// revision, read in one statement so both come from the same snapshot.
	// Roles are null unless the identity is a member of an active tenant; the
	// revision is null only when the tenant does not exist.
	const access = async (identity: VerifiedIdentity, tenantId: string) => {
		const found = await db
			.select({ revision: tenants.access_revision, status: tenants.status, role: memberships.role })
			.from(tenants)
			.leftJoin(
				memberships,
				and(
					eq(memberships.tenant_id, tenants.id),
					eq(memberships.provider, identity.provider),
					eq(memberships.subject, identity.subject),
				),
			)
			.where(eq(tenants.id, tenantId))
			.orderBy(asc(memberships.role));
		const [first] = found;
		if (!first) return { revision: null, roles: null };
		const roles = first.status === "active" ? found.flatMap(({ role }) => (role === null ? [] : [role])) : [];
		return { revision: first.revision, roles: roles.length > 0 ? roles : null };
	};

	return { list, access };
};

export type MembershipsService = ReturnType<typeof createMembershipsService>;
