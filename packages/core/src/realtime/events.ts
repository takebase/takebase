import type { RecordChangeEvent, RecordChangeOperation } from "@takebase/contracts";
import { eq, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Database } from "../storage/d1.ts";
import { outbox } from "./outbox.ts";

export type OutboxRow = typeof outbox.$inferSelect;

// The values of a new pending event; `seq` (the revision) comes from D1.
export const outboxEntry = (collection: string, operation: RecordChangeOperation, recordId: string, now: Date) => {
	const timestamp = now.toISOString();
	return {
		id: crypto.randomUUID(),
		collection,
		operation,
		record_id: recordId,
		created: timestamp,
		available_at: timestamp,
	};
};

// Inserts the event only if the record exists, so an update or delete that
// matched nothing in the same batch emits nothing. Drizzle requires every
// outbox column, in table order; values are bound parameters.
export const outboxEntryIfExists = (
	db: Database,
	entry: ReturnType<typeof outboxEntry>,
	table: SQLiteTable,
	idColumn: SQLiteColumn,
) =>
	db.insert(outbox).select((qb) =>
		qb
			.select({
				seq: sql<number>`null`.as("seq"),
				id: sql<string>`${entry.id}`.as("id"),
				collection: sql<string>`${entry.collection}`.as("collection"),
				operation: sql<RecordChangeOperation>`${entry.operation}`.as("operation"),
				record_id: sql<string>`${entry.record_id}`.as("record_id"),
				created: sql<string>`${entry.created}`.as("created"),
				status: sql<"pending">`'pending'`.as("status"),
				attempts: sql<number>`0`.as("attempts"),
				available_at: sql<string>`${entry.available_at}`.as("available_at"),
				lease_token: sql<null>`null`.as("lease_token"),
				lease_until: sql<null>`null`.as("lease_until"),
				delivered_at: sql<null>`null`.as("delivered_at"),
			})
			.from(table)
			.where(eq(idColumn, entry.record_id)),
	);

export const toRecordChangeEvent = (row: OutboxRow): RecordChangeEvent => ({
	id: row.id,
	revision: row.seq,
	collection: row.collection,
	operation: row.operation,
	recordId: row.record_id,
	created: row.created,
});
