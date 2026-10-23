import { type FilterOperator, filterOperators, maxPerPage } from "@takebase/contracts";
import { getTableColumns } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

// List queries in the style of spatie/laravel-query-builder: a collection
// declares `filters` and `sorts`, and anything else in the query is rejected.
// Field names only select columns resolved here at startup; values stay data.

export type FilterRules = Record<string, readonly FilterOperator[]>;

type ValueKind = "string" | "number" | "boolean";

type FilterableField = { column: SQLiteColumn; kind: ValueKind; operators: ReadonlySet<FilterOperator> };

export type ListSpec = {
	readonly filters: ReadonlyMap<string, FilterableField>;
	readonly sorts: ReadonlyMap<string, SQLiteColumn>;
};

export type FilterCondition =
	| { column: SQLiteColumn; operator: Exclude<FilterOperator, "in" | "null">; value: FilterValue }
	| { column: SQLiteColumn; operator: "in"; value: FilterValue[] }
	| { column: SQLiteColumn; operator: "null"; value: boolean };

type FilterValue = string | number | boolean;

export type SortTerm = { column: SQLiteColumn; field: string; direction: "asc" | "desc" };

export type ParsedListQuery = { page: number; perPage: number; filters: FilterCondition[]; sort: SortTerm[] };

export const listLimits = {
	defaultPerPage: 30,
	maxPerPage,
	maxFilters: 10,
	maxSorts: 3,
	maxInValues: 50,
	maxValueLength: 256,
};

export class ListQueryError extends Error {}

const fieldPattern = /^[a-z_][a-z0-9_]{0,62}$/;
const filterKeyPattern = /^filter\[([^\]]*)\](?:\[([^\]]*)\])?$/;
const numberPattern = /^-?(0|[1-9]\d{0,14})(\.\d{1,15})?$/;

const valueKind = (column: SQLiteColumn): ValueKind | undefined => {
	if (column.dataType === "string" || column.dataType === "number" || column.dataType === "boolean")
		return column.dataType;
	return undefined;
};

// Checks the declared filters and sorts once, so requests never meet an invalid one.
export const compileListSpec = (
	name: string,
	table: SQLiteTable,
	filters: FilterRules = {},
	sorts: readonly string[] = [],
): ListSpec => {
	const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
	const column = (field: string) => {
		const found = Object.hasOwn(columns, field) ? columns[field] : undefined;
		if (!found || !fieldPattern.test(field)) throw new Error(`Collection "${name}" lists unknown column "${field}"`);
		return found;
	};

	const compiledFilters = new Map<string, FilterableField>();
	for (const [field, operators] of Object.entries(filters)) {
		const target = column(field);
		const kind = valueKind(target);
		if (!kind) throw new Error(`Collection "${name}" cannot filter "${field}" of type ${target.dataType}`);
		for (const operator of operators) {
			if (!(filterOperators as readonly string[]).includes(operator))
				throw new Error(`Collection "${name}" uses unknown filter operator "${operator}"`);
		}
		compiledFilters.set(field, { column: target, kind, operators: new Set(operators) });
	}

	const compiledSorts = new Map<string, SQLiteColumn>();
	for (const field of sorts) compiledSorts.set(field, column(field));

	return { filters: compiledFilters, sorts: compiledSorts };
};

const fail = (message: string): never => {
	throw new ListQueryError(message);
};

const parsePositiveInt = (value: string | undefined, fallback: number, name: string) => {
	if (value === undefined) return fallback;
	if (!/^[1-9]\d{0,6}$/.test(value)) fail(`"${name}" must be a positive integer`);
	return Number(value);
};

const parseValue = (raw: string, kind: ValueKind, field: string): FilterValue => {
	if (raw.length > listLimits.maxValueLength) fail(`Filter value for "${field}" is too long`);
	if (kind === "string") return raw;
	if (kind === "number") {
		if (!numberPattern.test(raw)) fail(`Filter value for "${field}" must be a number`);
		return Number(raw);
	}
	if (raw !== "true" && raw !== "false") fail(`Filter value for "${field}" must be true or false`);
	return raw === "true";
};

const parseFilter = (spec: ListSpec, field: string, operator: string, raw: string): FilterCondition => {
	const allowed = spec.filters.get(field);
	if (!allowed) return fail(`Filtering by "${field}" is not allowed`);
	if (!allowed.operators.has(operator as FilterOperator))
		return fail(`Operator "${operator}" is not allowed for "${field}"`);
	const { column, kind } = allowed;
	if (operator === "null") {
		if (raw !== "true" && raw !== "false") fail(`Filter "${field}[null]" must be true or false`);
		return { column, operator, value: raw === "true" };
	}
	if (operator === "in") {
		const parts = raw.split(",");
		if (raw === "" || parts.length > listLimits.maxInValues)
			fail(`Filter "${field}[in]" takes 1 to ${listLimits.maxInValues} values`);
		return { column, operator, value: parts.map((part) => parseValue(part, kind, field)) };
	}
	return { column, operator: operator as Exclude<FilterOperator, "in" | "null">, value: parseValue(raw, kind, field) };
};

const parseSort = (spec: ListSpec, raw: string): SortTerm[] => {
	const terms = raw.split(",");
	if (terms.length > listLimits.maxSorts) fail(`At most ${listLimits.maxSorts} sort fields are allowed`);
	const seen = new Set<string>();
	return terms.map((term) => {
		const descending = term.startsWith("-");
		const field = descending ? term.slice(1) : term;
		const column = spec.sorts.get(field);
		if (!column) return fail(`Sorting by "${field}" is not allowed`);
		if (seen.has(field)) fail(`"${field}" is sorted more than once`);
		seen.add(field);
		return { column, field, direction: descending ? "desc" : "asc" };
	});
};

// Parses `page`, `perPage`, `sort` and `filter[field][operator]`; other
// parameters are ignored. Anything ambiguous or undeclared throws ListQueryError.
export const parseListQuery = (params: URLSearchParams, spec: ListSpec): ParsedListQuery => {
	const single = (key: string) => {
		const values = params.getAll(key);
		if (values.length > 1) fail(`"${key}" is given more than once`);
		return values[0];
	};

	const page = parsePositiveInt(single("page"), 1, "page");
	const perPage = parsePositiveInt(single("perPage"), listLimits.defaultPerPage, "perPage");
	if (perPage > listLimits.maxPerPage) fail(`"perPage" must be at most ${listLimits.maxPerPage}`);

	const sortParam = single("sort");
	const sort = sortParam === undefined ? [] : parseSort(spec, sortParam);

	const filters: FilterCondition[] = [];
	for (const key of new Set(params.keys())) {
		if (key !== "filter" && !key.startsWith("filter[")) continue;
		const match = filterKeyPattern.exec(key);
		if (!match) fail(`Use filter[field] or filter[field][operator] instead of "${key}"`);
		const [, field = "", operator = "eq"] = match as RegExpExecArray;
		filters.push(parseFilter(spec, field, operator, single(key) as string));
		if (filters.length > listLimits.maxFilters) fail(`At most ${listLimits.maxFilters} filters are allowed`);
	}

	return { page, perPage, filters, sort };
};
