// Child process for `takebase collection inspect`: loads a Worker's collection
// registry module and prints one collection's definition as JSON. It runs apart
// from the CLI so the Worker's modules (and their imports) never load into it.
//
// Usage: node collection-loader.ts <registry-module> <collection-name>
import { pathToFileURL } from "node:url";

type Column = { name: string; notNull: boolean; primary: boolean; isUnique: boolean; getSQLType: () => string };
type ParsedRule = { name: string; args: string[] };
type CompiledField = {
	required: boolean;
	nullable: boolean;
	checks: ParsedRule[];
	database: { name: string; table: string | null; column: string | null }[];
};
type Definition = {
	name: string;
	table: Record<symbol, unknown>;
	rules: Record<string, unknown>;
	validation: Record<string, CompiledField>;
	list: { filters: Map<string, { operators: Set<string> }>; sorts: Map<string, unknown> };
	hooks: Record<string, unknown>;
};
type Registry = { get: (name: string) => Definition | undefined; names: () => string[] };

const operations = ["list", "view", "create", "update", "delete"];

const isRegistry = (value: unknown): value is Registry =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as Registry).get === "function" &&
	typeof (value as Registry).names === "function";

// Rebuilds the Laravel rule string from the compiled rules.
const ruleString = (field: CompiledField) =>
	[
		...(field.required ? ["required"] : []),
		...(field.nullable ? ["nullable"] : []),
		...field.checks.map(({ name, args }) =>
			name === "regex" ? `regex:/${args[0]}/${args[1]}` : args.length > 0 ? `${name}:${args.join(",")}` : name,
		),
		...field.database.map(({ name, table, column }) =>
			table === null ? name : `${name}:${[table, column].filter((part) => part !== null).join(",")}`,
		),
	].join("|");

// A named rule such as `authenticated` shows its name; inline rules show "custom".
const ruleLabel = (operation: string, rule: unknown) => {
	if (typeof rule !== "function") return "denied (no rule)";
	return rule.name !== "" && rule.name !== operation ? rule.name : "custom";
};

const describe = (definition: Definition) => {
	const columns = definition.table[Symbol.for("drizzle:Columns")] as Record<string, Column>;
	return {
		name: definition.name,
		table: String(definition.table[Symbol.for("drizzle:Name")]),
		columns: Object.entries(columns).map(([field, column]) => ({
			field,
			name: column.name,
			type: column.getSQLType(),
			notNull: column.notNull,
			primaryKey: column.primary,
			unique: column.isUnique,
		})),
		rules: Object.fromEntries(
			operations.map((operation) => [
				operation,
				ruleLabel(operation, Object.hasOwn(definition.rules, operation) ? definition.rules[operation] : undefined),
			]),
		),
		validation: Object.fromEntries(
			Object.entries(definition.validation).map(([field, rules]) => [field, ruleString(rules)]),
		),
		filters: Object.fromEntries([...definition.list.filters].map(([field, filter]) => [field, [...filter.operators]])),
		sorts: [...definition.list.sorts.keys()],
		hooks: Object.keys(definition.hooks),
	};
};

const [modulePath, name] = process.argv.slice(2);
if (modulePath === undefined || name === undefined) throw new Error("Usage: collection-loader <module> <name>");
const exported = Object.values((await import(pathToFileURL(modulePath).href)) as Record<string, unknown>);
const registry = exported.find(isRegistry);
if (!registry) {
	process.stdout.write(JSON.stringify({ error: "no-registry" }));
} else {
	const definition = registry.get(name);
	process.stdout.write(
		JSON.stringify(definition ? { collection: describe(definition) } : { error: "not-found", names: registry.names() }),
	);
}
