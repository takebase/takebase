import { id, timestamps } from "@takebase/core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "./agents.ts";

// Tenant D1 table; `pnpm db:generate` turns changes here into migrations/tenant SQL.
export const policies = sqliteTable("policies", {
	...id(),
	number: text("number").notNull().unique(),
	holder: text("holder").notNull(),
	status: text("status", { enum: ["pending", "active", "cancelled"] }).notNull(),
	agent_id: text("agent_id").references(() => agents.id),
	premium: integer("premium"),
	notes: text("notes"),
	...timestamps(),
});
