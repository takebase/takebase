import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// Plain tenant table, not exposed as a collection; policies reference it.
export const agents = sqliteTable("agents", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
});
