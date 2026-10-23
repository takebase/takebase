import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import {
	compileListSpec,
	defineCollection,
	id,
	ListQueryError,
	listLimits,
	parseListQuery,
	timestamps,
} from "../src/index.ts";

const notes = sqliteTable("notes", {
	...id(),
	title: text("title").notNull(),
	status: text("status", { enum: ["draft", "live"] }).notNull(),
	rank: integer("rank"),
	pinned: integer("pinned", { mode: "boolean" }),
	secret: text("secret"),
	published: integer("published", { mode: "timestamp" }),
	...timestamps(),
});

const spec = compileListSpec(
	"notes",
	notes,
	{
		status: ["eq", "ne", "in"],
		rank: ["eq", "gt", "gte", "lt", "lte", "in", "null"],
		pinned: ["eq"],
	},
	["created", "rank", "title"],
);

const parse = (query: string) => parseListQuery(new URLSearchParams(query), spec);
const rejects = (query: string, message?: RegExp) => {
	expect(() => parse(query), query).toThrow(ListQueryError);
	if (message) expect(() => parse(query), query).toThrow(message);
};
const conditions = (query: string) =>
	parse(query).filters.map(({ column, operator, value }) => [column.name, operator, value]);

describe("compileListSpec", () => {
	it("is built by defineCollection and allows nothing by default", () => {
		const collection = defineCollection({ table: notes, rules: {}, validate: {} });
		expect(collection.list.filters.size).toBe(0);
		expect(collection.list.sorts.size).toBe(0);
		expect(() => parseListQuery(new URLSearchParams("filter[title]=x"), collection.list)).toThrow(/not allowed/);
		expect(() => parseListQuery(new URLSearchParams("sort=created"), collection.list)).toThrow(/not allowed/);
	});

	it("rejects unknown columns, operators and unsupported types at startup", () => {
		expect(() => compileListSpec("notes", notes, { missing: ["eq"] })).toThrow(/unknown column "missing"/);
		expect(() => compileListSpec("notes", notes, JSON.parse(`{"constructor":["eq"]}`))).toThrow(/unknown column/);
		expect(() => compileListSpec("notes", notes, {}, ["missing"])).toThrow(/unknown column "missing"/);
		expect(() => compileListSpec("notes", notes, { title: ["like"] as unknown as ["eq"] })).toThrow(
			/unknown filter operator/,
		);
		expect(() => compileListSpec("notes", notes, { published: ["eq"] })).toThrow(/cannot filter "published"/);
	});
});

describe("parseListQuery", () => {
	it("defaults to page 1 of 30 with no filters and the default order", () => {
		expect(parse("")).toEqual({ page: 1, perPage: listLimits.defaultPerPage, filters: [], sort: [] });
	});

	it("parses declared filters into bound values of the column's type", () => {
		expect(conditions("filter[status]=live&filter[rank][gte]=2&filter[rank][lt]=10.5&filter[pinned]=true")).toEqual([
			["status", "eq", "live"],
			["rank", "gte", 2],
			["rank", "lt", 10.5],
			["pinned", "eq", true],
		]);
		expect(conditions("filter[status][in]=draft,live&filter[rank][null]=false")).toEqual([
			["status", "in", ["draft", "live"]],
			["rank", "null", false],
		]);
	});

	it("keeps injection attempts in values as plain data", () => {
		expect(conditions(`filter[status]=${encodeURIComponent("live' OR '1'='1")}`)).toEqual([
			["status", "eq", "live' OR '1'='1"],
		]);
	});

	it("parses sort terms in order", () => {
		expect(parse("sort=-rank,title").sort.map(({ field, direction }) => [field, direction])).toEqual([
			["rank", "desc"],
			["title", "asc"],
		]);
	});

	it("rejects undeclared or private fields and operators", () => {
		rejects("filter[secret]=x", /Filtering by "secret" is not allowed/);
		rejects("filter[title]=x");
		rejects("filter[status][gt]=a", /Operator "gt" is not allowed/);
		rejects("filter[pinned][like]=x");
		rejects("sort=secret", /Sorting by "secret" is not allowed/);
		rejects("sort=-status");
	});

	it("rejects injection attempts in field names and malformed keys", () => {
		rejects(`filter[${encodeURIComponent("status) OR 1=1 --")}]=x`);
		rejects(`sort=${encodeURIComponent("rank; DROP TABLE notes")}`);
		rejects("filter=status='live'", /Use filter\[field\]/);
		rejects("filter[status][eq][x]=live");
		rejects("filter[]=x");
		rejects("filter[status]x=live");
	});

	it("rejects values that do not fit the column", () => {
		rejects("filter[rank]=abc", /must be a number/);
		for (const value of ["1e3", "Infinity", "NaN", " 1", "0x10", "01", ""]) rejects(`filter[rank]=${value}`);
		rejects("filter[pinned]=1", /true or false/);
		rejects("filter[rank][null]=yes");
		rejects(`filter[status]=${"x".repeat(listLimits.maxValueLength + 1)}`, /too long/);
		rejects("filter[status][in]=", /takes 1 to/);
		rejects("filter[rank][in]=1,,2");
	});

	it("enforces page, size, filter, sort and value-count bounds", () => {
		for (const query of ["page=0", "page=1.5", "page=-1", "perPage=0", `perPage=${listLimits.maxPerPage + 1}`])
			rejects(query);
		expect(parse(`perPage=${listLimits.maxPerPage}`).perPage).toBe(listLimits.maxPerPage);

		const values = (count: number) => Array.from({ length: count }, (_, i) => i).join(",");
		expect(conditions(`filter[rank][in]=${values(listLimits.maxInValues)}`)[0]?.[2]).toHaveLength(
			listLimits.maxInValues,
		);
		rejects(`filter[rank][in]=${values(listLimits.maxInValues + 1)}`);

		rejects("sort=rank,title,created,-rank", /At most 3 sort fields/);
		rejects("sort=rank,-rank", /more than once/);
		rejects("sort=");
		rejects("sort=rank&sort=title", /more than once/);
		rejects("filter[status]=live&filter[status]=draft", /more than once/);

		const filters = [
			"filter[rank]=1",
			"filter[rank][gt]=1",
			"filter[rank][gte]=1",
			"filter[rank][lt]=1",
			"filter[rank][lte]=1",
			"filter[rank][in]=1",
			"filter[rank][null]=false",
			"filter[status]=live",
			"filter[status][ne]=draft",
			"filter[status][in]=live",
			"filter[pinned]=true",
		];
		expect(filters).toHaveLength(listLimits.maxFilters + 1);
		expect(parse(filters.slice(0, listLimits.maxFilters).join("&")).filters).toHaveLength(listLimits.maxFilters);
		rejects(filters.join("&"), /At most 10 filters/);
	});

	it("ignores unrelated parameters", () => {
		expect(parse("_=123&expand=agent").filters).toEqual([]);
	});
});
