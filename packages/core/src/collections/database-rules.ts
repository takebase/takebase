import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { CollectionDefinition } from "./define-collection.ts";
import type { DatabaseRule } from "./validation.ts";

// A `unique`/`exists` rule bound to real Drizzle objects. `ignoreCurrent` makes an
// update skip its own record, like Laravel's Rule::unique(...)->ignore($id).
export type ResolvedLookup = { table: SQLiteTable; column: SQLiteColumn; ignoreCurrent: boolean };

const findColumn = (table: SQLiteTable, name: string) => {
	const columns = getTableColumns(table);
	return Object.values(columns).find((column) => column.name === name) ?? columns[name];
};

// Binds every database rule of a collection to a known table and column, or throws
// at startup; requests can only reach tables and columns resolved here.
export const resolveDatabaseRules = (definition: CollectionDefinition, tables: ReadonlyMap<string, SQLiteTable>) => {
	const resolved = new Map<DatabaseRule, ResolvedLookup>();
	for (const [field, compiled] of Object.entries(definition.validation)) {
		for (const rule of compiled.database) {
			const table = rule.table === null ? definition.table : tables.get(rule.table);
			if (!table)
				throw new Error(`Rule "${rule.name}" on ${definition.name}.${field} names unknown table "${rule.table}"`);
			const columnName = rule.column ?? field;
			const column = findColumn(table, columnName);
			if (!column) {
				throw new Error(
					`Rule "${rule.name}" on ${definition.name}.${field} names unknown column "${getTableName(table)}.${columnName}"`,
				);
			}
			resolved.set(rule, { table, column, ignoreCurrent: rule.name === "unique" && table === definition.table });
		}
	}
	return resolved;
};
