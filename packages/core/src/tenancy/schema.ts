import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
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
		...timestamps(),
	},
	(table) => [check("tenants_status", sql`${table.status} in ('active', 'disabled')`)],
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
