import { and, eq, isNull, lte, max } from "drizzle-orm";
import { type AnyD1Database, createDatabase } from "../storage/d1.ts";
import { memberRevocations, tenantRevocations, tenants } from "../tenancy/schema.ts";

// All SQL for realtime revocations lives here (global D1): tenant-wide ones
// (tenant disabled) and one user's (removed, disabled, sessions revoked).

export const createRevocationsService = (d1: AnyD1Database) => {
	const db = createDatabase(d1);

	// The newest unconfirmed revocation of a tenant that is still disabled, or
	// null. A tenant enabled again owes nothing: revoking at an older revision
	// would end grants that its current members were given since.
	const pending = async (tenantId: string): Promise<number | null> => {
		const [row] = await db
			.select({ rev: max(tenantRevocations.rev) })
			.from(tenantRevocations)
			.innerJoin(tenants, eq(tenants.id, tenantRevocations.tenant_id))
			.where(
				and(
					eq(tenantRevocations.tenant_id, tenantId),
					isNull(tenantRevocations.confirmed),
					eq(tenants.status, "disabled"),
				),
			);
		return row?.rev ?? null;
	};

	// Marks every revocation up to `rev` delivered; a revocation at `rev`
	// covers all older ones.
	const confirm = async (tenantId: string, rev: number, now: Date) => {
		await db
			.update(tenantRevocations)
			.set({ confirmed: now.toISOString() })
			.where(
				and(
					eq(tenantRevocations.tenant_id, tenantId),
					lte(tenantRevocations.rev, rev),
					isNull(tenantRevocations.confirmed),
				),
			);
	};

	// One entry per user still owed a revocation in this tenant, at their newest
	// pending revision (it covers the older ones). Bounded per call; reconcile
	// again for the rest.
	const pendingMembers = async (tenantId: string, limit = 100) =>
		db
			.select({
				provider: memberRevocations.provider,
				subject: memberRevocations.subject,
				rev: max(memberRevocations.rev).mapWith(Number),
			})
			.from(memberRevocations)
			.where(and(eq(memberRevocations.tenant_id, tenantId), isNull(memberRevocations.confirmed)))
			.groupBy(memberRevocations.provider, memberRevocations.subject)
			.limit(limit);

	const confirmMember = async (tenantId: string, provider: string, subject: string, rev: number, now: Date) => {
		await db
			.update(memberRevocations)
			.set({ confirmed: now.toISOString() })
			.where(
				and(
					eq(memberRevocations.tenant_id, tenantId),
					eq(memberRevocations.provider, provider),
					eq(memberRevocations.subject, subject),
					lte(memberRevocations.rev, rev),
					isNull(memberRevocations.confirmed),
				),
			);
	};

	return { pending, confirm, pendingMembers, confirmMember };
};

export type RevocationsService = ReturnType<typeof createRevocationsService>;
