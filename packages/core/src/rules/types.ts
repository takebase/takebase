import type { CollectionOperation } from "@takebase/contracts";

// The caller a rule judges: a verified member of this tenant, or `null` when
// anonymous. `id` is the identity provider's subject (a Firebase uid) and
// `roles` its roles in the tenant, read from global D1 on every request.
export type AuthIdentity = { id: string; provider: string; roles: readonly string[] };

export type RuleContext = {
	auth: AuthIdentity | null;
	collection: string;
	operation: CollectionOperation;
};

export type Rule = (context: RuleContext) => boolean | Promise<boolean>;

// An operation without a rule is denied.
export type CollectionRules = Partial<Record<CollectionOperation, Rule>>;
