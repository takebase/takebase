// Laravel-style field validation: each field declares rules as "required|string|max:200"
// or as an array (use the array form for `regex:` patterns containing "|").
// A failure is a message key plus parameters; a message catalog renders it, so
// translations are a new catalog, not a change to the rules or the engine.
// `unique` and `exists` query the database through a lookup the caller provides,
// after the field's other rules pass.

import type { FieldErrors } from "@takebase/contracts";

export type FieldRules = string | readonly string[];
export type ValidationRules = Record<string, FieldRules>;

// `create` checks every rule; `update` checks only the fields that were sent,
// so `required` behaves like Laravel's `sometimes`.
export type ValidationMode = "create" | "update";

export type RuleFailure = { key: string; params: Record<string, string> };

export type Messages = Record<string, string>;

export type ValidationResult =
	| { ok: true; data: Record<string, unknown> }
	| { ok: false; failures: Record<string, RuleFailure>; fields: FieldErrors };

export const defaultMessages: Messages = {
	required: "The :attribute field is required.",
	prohibited: "The :attribute field is prohibited.",
	string: "The :attribute field must be a string.",
	integer: "The :attribute field must be an integer.",
	numeric: "The :attribute field must be a number.",
	boolean: "The :attribute field must be true or false.",
	email: "The :attribute field must be a valid email address.",
	url: "The :attribute field must be a valid URL.",
	uuid: "The :attribute field must be a valid UUID.",
	date: "The :attribute field must be a valid date.",
	regex: "The :attribute field format is invalid.",
	in: "The selected :attribute is invalid.",
	unique: "The :attribute has already been taken.",
	exists: "The selected :attribute is invalid.",
	"min.string": "The :attribute field must be at least :min characters.",
	"min.numeric": "The :attribute field must be at least :min.",
	"max.string": "The :attribute field must not be greater than :max characters.",
	"max.numeric": "The :attribute field must not be greater than :max.",
};

type ParsedRule = { name: string; args: string[] };

// Laravel's `unique[:table[,column]]` and `exists:table[,column]`. A missing table
// means the collection's own table; a missing column means the field's own name.
// Names are resolved against known Drizzle tables at startup, never used as SQL.
export type DatabaseRule = { name: "unique" | "exists"; table: string | null; column: string | null };

// Answers whether a database rule passes for a value that passed every other rule.
export type DatabaseLookup = (field: string, rule: DatabaseRule, value: unknown) => Promise<boolean>;

export type CompiledField = {
	required: boolean;
	nullable: boolean;
	checks: ParsedRule[];
	database: DatabaseRule[];
};

export type CompiledRules = Record<string, CompiledField>;

// `sometimes` is accepted for familiarity: absent fields without `required` are skipped anyway.
const presenceRules = new Set(["required", "nullable", "sometimes"]);
const ruleArity: Record<string, "none" | "number" | "list" | "pattern"> = {
	string: "none",
	integer: "none",
	numeric: "none",
	boolean: "none",
	email: "none",
	url: "none",
	uuid: "none",
	date: "none",
	min: "number",
	max: "number",
	in: "list",
	regex: "pattern",
};

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const parseDatabaseRule = (field: string, name: "unique" | "exists", rest: string | null): DatabaseRule => {
	const args = rest === null ? [] : rest.split(",").map((arg) => arg.trim());
	if (name === "exists" && args.length === 0) throw new Error(`Rule "exists" on field "${field}" needs a table`);
	if (args.length > 2 || args.some((arg) => !identifierPattern.test(arg))) {
		throw new Error(`Rule "${name}" on field "${field}" takes "table" and optional "column" names`);
	}
	return { name, table: args[0] ?? null, column: args[1] ?? null };
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

const parseRule = (field: string, rule: string): ParsedRule => {
	const colon = rule.indexOf(":");
	const name = colon === -1 ? rule : rule.slice(0, colon);
	const rest = colon === -1 ? "" : rule.slice(colon + 1);
	if (presenceRules.has(name) && colon === -1) return { name, args: [] };
	const arity = ruleArity[name];
	if (!arity) throw new Error(`Unknown validation rule "${name}" on field "${field}"`);
	if (arity === "none") {
		if (colon !== -1) throw new Error(`Rule "${name}" on field "${field}" takes no arguments`);
		return { name, args: [] };
	}
	if (rest === "") throw new Error(`Rule "${name}" on field "${field}" needs an argument`);
	if (arity === "number" && !Number.isFinite(Number(rest))) {
		throw new Error(`Rule "${name}" on field "${field}" needs a number, got "${rest}"`);
	}
	if (arity === "pattern") {
		const match = /^\/(.*)\/([a-z]*)$/s.exec(rest);
		if (!match) throw new Error(`Rule "regex" on field "${field}" needs a /pattern/flags argument`);
		new RegExp(match[1] ?? "", match[2]);
		return { name, args: [match[1] ?? "", match[2] ?? ""] };
	}
	return { name, args: arity === "list" ? rest.split(",") : [rest] };
};

// Compiles rules once, when a collection is defined; unknown or malformed rules throw there.
export const compileRules = (rules: ValidationRules): CompiledRules => {
	const compiled: CompiledRules = {};
	for (const [field, fieldRules] of Object.entries(rules)) {
		const list = typeof fieldRules === "string" ? fieldRules.split("|") : [...fieldRules];
		const parsed: ParsedRule[] = [];
		const database: DatabaseRule[] = [];
		for (const rule of list.map((item) => item.trim()).filter((item) => item !== "")) {
			const colon = rule.indexOf(":");
			const name = colon === -1 ? rule : rule.slice(0, colon);
			if (name === "unique" || name === "exists") {
				database.push(parseDatabaseRule(field, name, colon === -1 ? null : rule.slice(colon + 1)));
			} else parsed.push(parseRule(field, rule));
		}
		compiled[field] = {
			required: parsed.some((rule) => rule.name === "required"),
			nullable: parsed.some((rule) => rule.name === "nullable"),
			checks: parsed.filter((rule) => !presenceRules.has(rule.name)),
			database,
		};
	}
	return compiled;
};

const failure = (key: string, params: Record<string, string> = {}): RuleFailure => ({ key, params });

// Returns the first failing rule for a present, non-null value, or null when it passes.
const check = (value: unknown, rule: ParsedRule): RuleFailure | null => {
	const [arg = "", flags = ""] = rule.args;
	switch (rule.name) {
		case "string":
			return typeof value === "string" ? null : failure("string");
		case "integer":
			return Number.isInteger(value) ? null : failure("integer");
		case "numeric":
			return typeof value === "number" && Number.isFinite(value) ? null : failure("numeric");
		case "boolean":
			return typeof value === "boolean" ? null : failure("boolean");
		case "email":
			return typeof value === "string" && emailPattern.test(value) ? null : failure("email");
		case "url":
			return typeof value === "string" && URL.canParse(value) && /^https?:/i.test(value) ? null : failure("url");
		case "uuid":
			return typeof value === "string" && uuidPattern.test(value) ? null : failure("uuid");
		case "date":
			return typeof value === "string" && isoDatePattern.test(value) && !Number.isNaN(Date.parse(value))
				? null
				: failure("date");
		case "regex":
			return typeof value === "string" && new RegExp(arg, flags).test(value) ? null : failure("regex");
		case "in":
			return (typeof value === "string" || typeof value === "number") && rule.args.includes(String(value))
				? null
				: failure("in", { values: rule.args.join(", ") });
		case "min":
		case "max": {
			const limit = Number(arg);
			const size = typeof value === "string" ? value.length : typeof value === "number" ? value : null;
			const kind = typeof value === "string" ? "string" : "numeric";
			if (size === null) return failure(`${rule.name}.${kind}`, { [rule.name]: arg });
			const ok = rule.name === "min" ? size >= limit : size <= limit;
			return ok ? null : failure(`${rule.name}.${kind}`, { [rule.name]: arg });
		}
		default:
			throw new Error(`Unhandled validation rule "${rule.name}"`);
	}
};

const checkDatabase = async (field: string, value: unknown, rules: DatabaseRule[], lookup?: DatabaseLookup) => {
	for (const rule of rules) {
		if (!lookup) throw new Error(`Field "${field}" uses "${rule.name}" but no database lookup was provided`);
		if (!(await lookup(field, rule, value))) return failure(rule.name);
	}
	return null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// `attribute` defaults to the field name with underscores as spaces, as in Laravel.
export const formatMessage = (
	field: string,
	result: RuleFailure,
	messages: Messages = defaultMessages,
	attributes: Record<string, string> = {},
) => {
	const template = messages[result.key] ?? defaultMessages[result.key] ?? "The :attribute field is invalid.";
	const params: Record<string, string> = {
		attribute: attributes[field] ?? field.replaceAll("_", " "),
		...result.params,
	};
	return template.replace(/:([a-z]+)/g, (match, name: string) => params[name] ?? match);
};

export type ValidateOptions = {
	mode: ValidationMode;
	messages?: Messages;
	attributes?: Record<string, string>;
	// Required when any field declares `unique` or `exists`.
	lookup?: DatabaseLookup;
};

// Validates a JSON object against compiled rules. Fields without rules are
// prohibited, so only declared fields ever reach storage.
export const validate = async (
	input: unknown,
	rules: CompiledRules,
	options: ValidateOptions,
): Promise<ValidationResult> => {
	if (!isPlainObject(input)) throw new TypeError("validate() expects a JSON object");
	const failures: Record<string, RuleFailure> = {};
	const data: Record<string, unknown> = {};

	for (const field of Object.keys(input)) {
		if (!Object.hasOwn(rules, field)) failures[field] = failure("prohibited");
	}

	for (const [field, compiled] of Object.entries(rules)) {
		const present = Object.hasOwn(input, field) && input[field] !== undefined;
		const value = present ? input[field] : undefined;
		if (!present) {
			if (compiled.required && options.mode === "create") failures[field] = failure("required");
			continue;
		}
		if (value === null) {
			if (compiled.nullable) data[field] = null;
			else {
				const [first] = compiled.checks;
				failures[field] = (!compiled.required && first && check(null, first)) || failure("required");
			}
			continue;
		}
		if (compiled.required && value === "") {
			failures[field] = failure("required");
			continue;
		}
		const failed = compiled.checks.map((rule) => check(value, rule)).find((result) => result !== null);
		if (failed) {
			failures[field] = failed;
			continue;
		}
		const databaseFailure = await checkDatabase(field, value, compiled.database, options.lookup);
		if (databaseFailure) failures[field] = databaseFailure;
		else data[field] = value;
	}

	const failedFields = Object.keys(failures);
	if (failedFields.length === 0) return { ok: true, data };
	const fields: FieldErrors = {};
	for (const field of failedFields) {
		const result = failures[field];
		if (result) fields[field] = formatMessage(field, result, options.messages, options.attributes);
	}
	return { ok: false, failures, fields };
};
