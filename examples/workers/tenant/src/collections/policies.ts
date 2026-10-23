import { authenticated, defineCollection } from "@takebase/core";
import { policies } from "../schema/policies.ts";

// Requires an identity for every operation. Workers resolve none until
// Firebase identity arrives (Wave 3), so this collection is closed for now.
export const policiesCollection = defineCollection({
	table: policies,
	rules: {
		list: authenticated,
		view: authenticated,
		create: authenticated,
		update: authenticated,
		delete: authenticated,
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
});
