import type { CollectionRecord, ListEnvelope } from "@takebase/contracts";
import { and, count, desc, eq, getTableColumns, ne } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { type AnyD1Database, createDatabase } from "../storage/d1.ts";

// All SQL for collection records lives here; routes only call these functions.
// Every write is one statement, so D1 applies it atomically or not at all.

export type ListPage = { page: number; perPage: number };

type TableColumns = Record<string, SQLiteColumn> & { id: SQLiteColumn; created: SQLiteColumn };

export const createCollectionsService = (d1: AnyD1Database, table: SQLiteTable, now: Date) => {
	const db = createDatabase(d1);
	const columns = getTableColumns(table) as TableColumns;
	const byId = (id: string) => eq(columns.id, id);
	const timestamp = now.toISOString();

	const list = async ({ page, perPage }: ListPage): Promise<ListEnvelope<CollectionRecord>> => {
		const [totals] = await db.select({ total: count() }).from(table);
		const totalItems = totals?.total ?? 0;
		const items = await db
			.select()
			.from(table)
			.orderBy(desc(columns.created), desc(columns.id))
			.limit(perPage)
			.offset((page - 1) * perPage);
		return {
			items: items as CollectionRecord[],
			page,
			perPage,
			totalItems,
			totalPages: Math.ceil(totalItems / perPage),
		};
	};

	const view = async (id: string) => {
		const [record] = await db.select().from(table).where(byId(id)).limit(1);
		return (record as CollectionRecord | undefined) ?? null;
	};

	const create = async (data: Record<string, unknown>) => {
		const values = { ...data, id: crypto.randomUUID(), created: timestamp, updated: timestamp };
		const [record] = await db.insert(table).values(values).returning();
		return record as CollectionRecord;
	};

	const update = async (id: string, data: Record<string, unknown>) => {
		const [record] = await db
			.update(table)
			.set({ ...data, updated: timestamp })
			.where(byId(id))
			.returning();
		return (record as CollectionRecord | undefined) ?? null;
	};

	const remove = async (id: string) => {
		const deleted = await db.delete(table).where(byId(id)).returning({ id: columns.id });
		return deleted.length > 0;
	};

	return { list, view, create, update, remove };
};

// Backs `unique`/`exists`: whether `column` holds `value`, optionally skipping one
// record of `table` by id. Table and column are Drizzle objects resolved at startup.
export const recordExists = async (
	d1: AnyD1Database,
	table: SQLiteTable,
	column: SQLiteColumn,
	value: unknown,
	exceptId?: string,
) => {
	const db = createDatabase(d1);
	const match = eq(column, value);
	const where = exceptId === undefined ? match : and(match, ne((getTableColumns(table) as TableColumns).id, exceptId));
	const [row] = await db.select({ found: column }).from(table).where(where).limit(1);
	return row !== undefined;
};

export type CollectionsService = ReturnType<typeof createCollectionsService>;
