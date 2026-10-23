import { getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { type ResolvedLookup, resolveDatabaseRules } from "./database-rules.ts";
import type { CollectionDefinition } from "./define-collection.ts";
import type { DatabaseRule } from "./validation.ts";

// Immutable lookup built at startup; request input only ever selects an entry
// by exact name and never becomes a table or column identifier.
export type CollectionRegistry = {
	get: (name: string) => CollectionDefinition | undefined;
	names: () => string[];
	// The table and column a `unique`/`exists` rule was bound to at startup.
	lookup: (rule: DatabaseRule) => ResolvedLookup | undefined;
};

export type CollectionRegistryOptions = {
	// Tables that `exists`/`unique` rules may reference besides the collections' own.
	tables?: readonly SQLiteTable[];
};

export const createCollectionRegistry = (
	definitions: readonly CollectionDefinition[],
	options: CollectionRegistryOptions = {},
): CollectionRegistry => {
	const byName = new Map<string, CollectionDefinition>();
	for (const definition of definitions) {
		if (byName.has(definition.name)) throw new Error(`Collection "${definition.name}" is defined twice`);
		byName.set(definition.name, definition);
	}

	const tables = new Map<string, SQLiteTable>();
	for (const table of [...definitions.map((definition) => definition.table), ...(options.tables ?? [])]) {
		const name = getTableName(table);
		const known = tables.get(name);
		if (known && known !== table) throw new Error(`Two different tables are named "${name}"`);
		tables.set(name, table);
	}

	const lookups = new Map<DatabaseRule, ResolvedLookup>();
	for (const definition of definitions) {
		for (const [rule, resolved] of resolveDatabaseRules(definition, tables)) lookups.set(rule, resolved);
	}

	return {
		get: (name) => byName.get(name),
		names: () => [...byName.keys()],
		lookup: (rule) => lookups.get(rule),
	};
};
