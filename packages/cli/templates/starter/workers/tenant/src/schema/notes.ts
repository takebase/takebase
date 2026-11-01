import { id, integer, sqliteTable, text, timestamps } from "@takebase/core/schema";

// A tenant table; `takebase migrate generate` turns changes here into migrations.
export const notes = sqliteTable("notes", {
	...id(),
	title: text("title").notNull(),
	done: integer("done", { mode: "boolean" }).notNull(),
	...timestamps(),
});
