import { text } from "drizzle-orm/sqlite-core";

// Laravel-like column helpers: spread them into a Drizzle table definition.
// Values are owned by the server; clients can never write these fields.

// $table->id(): a text primary key the server fills with a UUID.
export const id = () => ({ id: text("id").primaryKey() });

// $table->timestamps(): ISO 8601 creation and last-update times.
export const timestamps = () => ({
	created: text("created").notNull(),
	updated: text("updated").notNull(),
});

export const serverOwnedFields = ["id", "created", "updated"] as const;
