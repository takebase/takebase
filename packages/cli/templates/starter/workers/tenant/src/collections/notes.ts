import { defineCollection, deny, hasRole, tenantMember } from "@takebase/core";
import { notes } from "../schema/notes.ts";

// Tenant members read notes, editors write them, nobody deletes them.
export const notesCollection = defineCollection({
	table: notes,
	rules: {
		list: tenantMember(),
		view: tenantMember(),
		create: hasRole("editor"),
		update: hasRole("editor"),
		delete: deny(),
	},
	validate: {
		title: "required|string|max:200",
		done: "required|boolean",
	},
	sorts: ["created"],
});
