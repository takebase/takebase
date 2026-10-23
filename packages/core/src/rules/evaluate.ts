import type { CollectionOperation, ErrorCode } from "@takebase/contracts";
import type { AuthIdentity, CollectionRules } from "./types.ts";

export type Decision =
	| { allowed: true }
	| { allowed: false; code: Extract<ErrorCode, "unauthenticated" | "forbidden"> };

// Deny by default: a missing rule, a false result or a throwing rule all deny.
// Anonymous callers get `unauthenticated`, identified callers `forbidden`.
export const evaluateRule = async (
	rules: CollectionRules,
	collection: string,
	operation: CollectionOperation,
	auth: AuthIdentity | null,
): Promise<Decision> => {
	const rule = Object.hasOwn(rules, operation) ? rules[operation] : undefined;
	let allowed = false;
	if (rule) {
		try {
			allowed = (await rule({ auth, collection, operation })) === true;
		} catch {
			allowed = false;
		}
	}
	if (allowed) return { allowed: true };
	return { allowed: false, code: auth === null ? "unauthenticated" : "forbidden" };
};
