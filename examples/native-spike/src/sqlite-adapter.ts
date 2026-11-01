import type { Binding, Database } from "bun:sqlite";
import type { AnyD1Database } from "../../../packages/core/src/storage/d1.ts";

// The D1 binding's shape over Bun's SQLite: exactly what Drizzle's D1 driver and
// the scenario call, so core runs unchanged. It adds nothing core could rely on.
// Differences from D1 are listed in benchmarks/README.md:
// - calls finish synchronously inside a promise, in this one process;
// - `meta` holds only `changes` and `last_row_id`, with no duration, rows read or
//   rows written;
// - only one writer, on one machine, with no replication or point-in-time recovery;
// - errors keep Bun's wording, so core's isConstraintError does not recognize a
//   trigger abort, and that answer is 500 instead of 409.

type Result = { results: Record<string, unknown>[]; success: true; meta: { changes: number; last_row_id: number } };

export const createSqliteD1 = (database: Database) => {
	const execute = (sql: string, values: Binding[]): Result => {
		const results = database.query(sql).all(...values);
		const meta = database
			.query("select changes() as changes, last_insert_rowid() as last_row_id")
			.all()[0] as Result["meta"];
		return { results, success: true, meta };
	};

	type Prepared = {
		sql: string;
		values: Binding[];
		bind: (...values: unknown[]) => Prepared;
		all: () => Promise<Result>;
		run: () => Promise<Result>;
		first: (column?: string) => Promise<unknown>;
		raw: () => Promise<unknown[][]>;
	};

	const prepared = (sql: string, values: Binding[]): Prepared => ({
		sql,
		values,
		// D1 refuses undefined too, so Bun's own error is left to surface it.
		bind: (...next) => prepared(sql, next as Binding[]),
		all: async () => execute(sql, values),
		run: async () => execute(sql, values),
		first: async (column) => {
			const [row] = execute(sql, values).results;
			if (row === undefined) return null;
			return column === undefined ? row : row[column];
		},
		raw: async () => database.query(sql).values(...values),
	});

	const d1 = {
		prepare: (sql: string) => prepared(sql, []),
		// A batch is one transaction: any failure rolls all of it back, as on D1.
		batch: async (statements: Prepared[]) =>
			database.transaction(() => statements.map(({ sql, values }) => execute(sql, values)))(),
	};
	return d1 as unknown as AnyD1Database;
};
