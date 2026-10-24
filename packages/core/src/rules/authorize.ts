import type { CollectionOperation } from "@takebase/contracts";
import { AuthError } from "../auth/membership.ts";
import { evaluateRule } from "./evaluate.ts";
import type { AuthIdentity, CollectionRules } from "./types.ts";

// Laravel's `Gate::authorize()` for custom routes that query Drizzle directly:
// call it before touching the database. It applies the collection's own rules
// with the same deny-by-default evaluation as the generated REST routes and
// throws AuthError (401 anonymous, 403 identified) when the rule denies.
export const authorize = async (
	collection: { name: string; rules: CollectionRules },
	operation: CollectionOperation,
	auth: AuthIdentity | null,
) => {
	const decision = await evaluateRule(collection.rules, collection.name, operation, auth);
	if (!decision.allowed) {
		throw new AuthError(decision.code, decision.code === "unauthenticated" ? "Authentication required" : "Not allowed");
	}
};
