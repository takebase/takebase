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

export const identityStatuses = ["active", "disabled", "deleted"] as const;

// Takebase's own record of an identity (the provider still owns the account).
// A disabled or deleted identity is refused on every request, and a token
// authenticated before `sessions_valid_after` (Unix seconds) is refused too:
// that is how sessions are revoked without the provider's admin API.
export const identities = sqliteTable(
	"identities",
	{
		provider: text("provider").notNull(),
		subject: text("subject").notNull(),
		status: text("status", { enum: identityStatuses }).notNull().default("active"),
		sessions_valid_after: integer("sessions_valid_after"),
		...timestamps(),
	},
	(table) => [
		primaryKey({ columns: [table.provider, table.subject] }),
		check("identities_status", sql`${table.status} in ('active', 'disabled', 'deleted')`),
	],
);

// The roles a tenant declares. `admin` is built in and seeded for every
// tenant; D1 triggers refuse a membership or invitation with an undeclared role.
export const tenantRoles = sqliteTable(
	"tenant_roles",
	{
		tenant_id: text("tenant_id")
			.notNull()
			.references(() => tenants.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		created: text("created").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.tenant_id, table.name] }),
		check("tenant_roles_name", sql`length(${table.name}) between 1 and 64`),
	],
);

// One user's realtime revocations still to deliver: D1 triggers insert one when
// a user loses their last role in a tenant, or when an identity is disabled,
// deleted or has its sessions revoked. The tenant Worker revokes that user's
// grant at `rev`, then sets `confirmed`.
export const memberRevocations = sqliteTable(
	"member_revocations",
	{
		tenant_id: text("tenant_id")
			.notNull()
			.references(() => tenants.id, { onDelete: "cascade" }),
		provider: text("provider").notNull(),
		subject: text("subject").notNull(),
		rev: integer("rev").notNull(),
		created: text("created").notNull(),
		confirmed: text("confirmed"),
	},
	(table) => [
		primaryKey({ columns: [table.tenant_id, table.provider, table.subject, table.rev] }),
		index("member_revocations_pending").on(table.tenant_id, table.confirmed),
	],
);

// Single-use invitations to one tenant role. Only a SHA-256 hash of the token
// is stored; redemption is one guarded UPDATE, so a token works at most once.
export const invitations = sqliteTable(
	"invitations",
	{
		...id(),
		tenant_id: text("tenant_id")
			.notNull()
			.references(() => tenants.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		token_hash: text("token_hash").notNull().unique(),
		created_by: text("created_by").notNull(),
		expires: text("expires").notNull(),
		redeemed_by: text("redeemed_by"),
		redeemed_at: text("redeemed_at"),
		revoked_at: text("revoked_at"),
		created: text("created").notNull(),
	},
	(table) => [index("invitations_tenant").on(table.tenant_id)],
);

// Append-only record of every administrative change, written in the same batch
// as the change. Never holds secrets or tokens. Kept after a tenant is deleted.
export const auditEvents = sqliteTable(
	"audit_events",
	{
		...id(),
		created: text("created").notNull(),
		// "operator" (the CLI) or "<provider>:<subject>" (the admin API).
		actor: text("actor").notNull(),
		action: text("action").notNull(),
		tenant_id: text("tenant_id"),
		target: text("target"),
		detail: text("detail"),
	},
	(table) => [index("audit_events_tenant").on(table.tenant_id, table.created)],
);
