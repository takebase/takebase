import { defineCollection, deny, hasRole, tenantMember } from "@takebase/core";
import { policies } from "../schema/policies.ts";

// Tenant members read and update policies, agents create them, nobody deletes.
export const policiesCollection = defineCollection({
	table: policies,
	rules: {
		list: tenantMember(),
		view: tenantMember(),
		create: hasRole("agent"),
		update: tenantMember(),
		delete: deny(),
	},
	validate: {
		// Laravel's unique/exists; the unique index and foreign key still guard races (409).
		number: "required|string|max:32|unique",
		holder: "required|string|min:2|max:120",
		status: "required|in:pending,active,cancelled",
		agent_id: "nullable|string|exists:agents,id",
		premium: "nullable|integer|min:0",
		notes: "nullable|string|max:2000",
	},
	// Lists may filter and sort only by these; `holder` and `notes` stay private.
	filters: {
		number: ["eq", "in"],
		status: ["eq", "ne", "in"],
		agent_id: ["eq", "in", "null"],
		premium: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "null"],
		created: ["gt", "gte", "lt", "lte"],
	},
	sorts: ["created", "updated", "number", "premium"],
});
