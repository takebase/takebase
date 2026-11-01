import { sqliteTable, text } from "@takebase/core/schema";

// Plain tenant table, not exposed as a collection; policies reference it.
export const agents = sqliteTable("agents", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
});
