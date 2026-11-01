import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { serverOwnedFields } from "./collections/columns.ts";

// What an application needs to declare its tables, so its code never imports
// the ORM. Tables built here are ordinary Drizzle tables: drizzle-kit reads them
// and advanced server-side code may still use Drizzle directly.
export {
	blob,
	foreignKey,
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
export { id, timestamps } from "./collections/columns.ts";

// A table's client-writable fields, for the SDK's `collection<Fields>(name)`.
export type CollectionFields<Table extends SQLiteTable> = Omit<
	Table["$inferSelect"],
	(typeof serverOwnedFields)[number]
>;
