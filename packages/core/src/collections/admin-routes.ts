import { type AdminCollection, type AdminCollectionList, collectionOperations } from "@takebase/contracts";
import { Hono } from "hono";
import { adminGate } from "../diagnostics/routes.ts";
import type { AuthIdentity } from "../rules/types.ts";
import type { CollectionDefinition } from "./define-collection.ts";
import type { CollectionRegistry } from "./registry.ts";

export type CollectionAdminRoutesOptions = {
	registry: CollectionRegistry;
	// The verified tenant member, set by the membership guard; null when anonymous.
	resolve: () => { auth: AuthIdentity | null };
};

// A field's rules written back as declared, e.g. ["required", "string", "max:32", "unique"].
const fieldRules = ({ required, nullable, checks, database }: CollectionDefinition["validation"][string]) => [
	...(required ? ["required"] : []),
	...(nullable ? ["nullable"] : []),
	...checks.map(({ name, args }) => (args.length === 0 ? name : `${name}:${args.join(",")}`)),
	...database.map(({ name, table, column }) =>
		table === null ? name : `${name}:${[table, column].filter((part) => part !== null).join(",")}`,
	),
];

const describe = (definition: CollectionDefinition): AdminCollection => ({
	name: definition.name,
	rules: Object.fromEntries(
		collectionOperations.map((operation) => [operation, definition.rules[operation]?.name || null]),
	) as AdminCollection["rules"],
	fields: Object.entries(definition.validation).map(([name, field]) => ({ name, rules: fieldRules(field) })),
	filters: Object.fromEntries([...definition.list.filters].map(([field, { operators }]) => [field, [...operators]])),
	sorts: [...definition.list.sorts.keys()],
});

// GET /api/admin/collections: how this tenant's collections are declared, for
// its admins only. Metadata from the registry, never records; access is still
// decided per request by each collection's rules.
export const createCollectionAdminRoutes = ({ registry, resolve }: CollectionAdminRoutesOptions) => {
	const routes = new Hono();
	routes.get("/api/admin/collections", (c) => {
		const refused = adminGate(c, resolve().auth);
		if (refused) return refused;
		const definitions = registry.names().flatMap((name) => registry.get(name) ?? []);
		const body: AdminCollectionList = { collections: definitions.map(describe) };
		return c.json(body);
	});
	return routes;
};
