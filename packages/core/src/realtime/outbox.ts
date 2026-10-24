import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Tenant D1 table owned by the framework. The tenant Worker's schema directory
// re-exports it so drizzle-kit generates migrations/tenant from it.
//
// Each row is written in the same D1 batch as the record change it describes,
// so a committed change always has its event and a rolled-back one never does.
// Rows hold invalidation metadata only, never record fields.

export const outboxOperations = ["create", "update", "delete"] as const;
export const outboxStatuses = ["pending", "delivered", "dead"] as const;

export const outbox = sqliteTable(
	"takebase_outbox",
	{
		// AUTOINCREMENT never reuses a value, so this is the event's revision.
		seq: integer("seq").primaryKey({ autoIncrement: true }),
		// The event id, stable across retries.
		id: text("id").notNull().unique(),
		collection: text("collection").notNull(),
		operation: text("operation", { enum: outboxOperations }).notNull(),
		record_id: text("record_id").notNull(),
		created: text("created").notNull(),
		status: text("status", { enum: outboxStatuses }).notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		// The earliest time a dispatcher may claim the event (retry backoff).
		available_at: text("available_at").notNull(),
		// Set while a dispatcher holds the event; an expired lease can be reclaimed.
		lease_token: text("lease_token"),
		lease_until: text("lease_until"),
		delivered_at: text("delivered_at"),
	},
	(table) => [
		check("takebase_outbox_operation", sql`${table.operation} in ('create', 'update', 'delete')`),
		check("takebase_outbox_status", sql`${table.status} in ('pending', 'delivered', 'dead')`),
		index("takebase_outbox_claimable").on(table.status, table.available_at),
	],
);
