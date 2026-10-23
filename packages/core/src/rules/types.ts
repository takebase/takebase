import type { CollectionOperation } from "@takebase/contracts";

// The caller a rule judges. Until Firebase identity arrives (Wave 3), Workers
// resolve `null`; only tests construct an identity, explicitly and internally.
export type AuthIdentity = { id: string };

export type RuleContext = {
	auth: AuthIdentity | null;
	collection: string;
	operation: CollectionOperation;
};

export type Rule = (context: RuleContext) => boolean | Promise<boolean>;

// An operation without a rule is denied.
export type CollectionRules = Partial<Record<CollectionOperation, Rule>>;
