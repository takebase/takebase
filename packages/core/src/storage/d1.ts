import { type AnyD1Database, drizzle } from "drizzle-orm/d1";

export type { AnyD1Database };

export const createDatabase = (d1: AnyD1Database) => drizzle(d1);

export type Database = ReturnType<typeof createDatabase>;

// D1 reports SQLite constraint violations (UNIQUE, CHECK, FOREIGN KEY, NOT NULL)
// in the error message; Drizzle wraps it as the cause.
export const isConstraintError = (error: unknown): boolean => {
	for (let current = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
		if (/SQLITE_CONSTRAINT|constraint failed/i.test(current.message)) return true;
	}
	return false;
};
