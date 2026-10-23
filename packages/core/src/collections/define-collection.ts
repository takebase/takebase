import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { CollectionRules } from "../rules/types.ts";
import { serverOwnedFields } from "./columns.ts";
import { compileListSpec, type FilterRules, type ListSpec } from "./query.ts";
import { type CompiledRules, compileRules, type Messages, type ValidationRules } from "./validation.ts";

export type CollectionOptions<Table extends SQLiteTable> = {
	table: Table;
	// URL name, `/api/collections/<name>/records`; defaults to the table name.
	name?: string;
	// Per-operation access rules; operations without a rule are denied.
	rules: CollectionRules;
	// Laravel-style rules for each client-writable field; other fields are rejected.
	validate: ValidationRules;
	// Message catalog and display names overriding the English defaults.
	messages?: Messages;
	attributes?: Record<string, string>;
	// Fields a list may filter by, with their allowed operators, and fields it
	// may sort by (spatie's allowedFilters/allowedSorts). Others return 400.
	filters?: FilterRules;
	sorts?: readonly string[];
};

export type CollectionDefinition<Table extends SQLiteTable = SQLiteTable> = {
	readonly name: string;
	readonly table: Table;
	readonly rules: Readonly<CollectionRules>;
	readonly validation: CompiledRules;
	readonly messages: Messages | undefined;
	readonly attributes: Record<string, string> | undefined;
	readonly list: ListSpec;
};

const namePattern = /^[a-z][a-z0-9_]{0,62}$/;

// Checks the definition once at startup, so requests never meet an invalid one.
export const defineCollection = <Table extends SQLiteTable>(
	options: CollectionOptions<Table>,
): CollectionDefinition<Table> => {
	const name = options.name ?? getTableName(options.table);
	if (!namePattern.test(name)) throw new Error(`Invalid collection name "${name}"`);

	const columns = Object.keys(getTableColumns(options.table));
	for (const field of serverOwnedFields) {
		if (!columns.includes(field))
			throw new Error(`Collection "${name}" needs an "${field}" column; use id() and timestamps()`);
	}
	for (const field of Object.keys(options.validate)) {
		if ((serverOwnedFields as readonly string[]).includes(field)) {
			throw new Error(`Collection "${name}" cannot validate server-owned field "${field}"`);
		}
		if (!columns.includes(field)) throw new Error(`Collection "${name}" validates unknown column "${field}"`);
	}

	return Object.freeze({
		name,
		table: options.table,
		rules: Object.freeze({ ...options.rules }),
		validation: compileRules(options.validate),
		messages: options.messages,
		attributes: options.attributes,
		list: compileListSpec(name, options.table, options.filters, options.sorts),
	});
};
