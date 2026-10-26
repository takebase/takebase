import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "../collections/columns.ts";

// Global D1 tables owned by the framework. The global Worker's schema directory
// re-exports them so drizzle-kit generates migrations/global from them.

export const tenantStatuses = ["active", "disabled"] as const;

export const tenants = sqliteTable(
	"tenants",
	{
		// A stable slug, e.g. "tenant-a": the same value as the tenant Worker's TENANT_ID.
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		// The tenant Worker's base URL the SDK routes to. Set on the server only;
		// no Worker ever fetches it.
		url: text("url").notNull(),
		status: text("status", { enum: tenantStatuses }).notNull(),
		// Bumped by D1 triggers (migrations/global) whenever this tenant's status or
		// any of its memberships changes; never decreases. Realtime grants carry it,
		// so a grant read before a revocation can never outrank that revocation.
		access_revision: integer("access_revision").notNull().default(0),
		...timestamps(),
	},
	(table) => [check("tenants_status", sql`${table.status} in ('active', 'disabled')`)],
);

// Tenant-wide realtime revocations still to deliver: a D1 trigger
// (migrations/global) inserts one whenever a disabled tenant's access revision
// moves, so the row commits with the status change. The tenant Worker revokes
// every realtime grant at `rev`, then sets `confirmed`.
export const tenantRevocations = sqliteTable(
	"tenant_revocations",
	{
		tenant_id: text("tenant_id")
			.notNull()
			.references(() => tenants.id, { onDelete: "cascade" }),
		rev: integer("rev").notNull(),
		created: text("created").notNull(),
		confirmed: text("confirmed"),
	},
	(table) => [primaryKey({ columns: [table.tenant_id, table.rev] })],
);

// One row per role (a Laravel role pivot). Removing a member deletes its rows.
export const memberships = sqliteTable(
	"memberships",
	{
		...id(),
		tenant_id: text("tenant_id")
			.notNull()
			.references(() => tenants.id, { onDelete: "cascade" }),
		// The identity adapter and its user id, e.g. "firebase" and a Firebase uid.
		provider: text("provider").notNull(),
		subject: text("subject").notNull(),
		role: text("role").notNull(),
		...timestamps(),
	},
	(table) => [
		unique("memberships_tenant_identity_role").on(table.tenant_id, table.provider, table.subject, table.role),
		index("memberships_identity").on(table.provider, table.subject),
	],
);
