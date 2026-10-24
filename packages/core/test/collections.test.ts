import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import {
	authenticated,
	createCollectionRegistry,
	defineCollection,
	deny,
	evaluateRule,
	id,
	timestamps,
} from "../src/index.ts";

const notes = sqliteTable("notes", { ...id(), title: text("title").notNull(), rank: integer("rank"), ...timestamps() });

describe("collection rules", () => {
	it("denies every operation without a rule", async () => {
		for (const operation of ["list", "view", "create", "update", "delete"] as const) {
			expect(await evaluateRule({}, "notes", operation, null)).toEqual({ allowed: false, code: "unauthenticated" });
			expect(await evaluateRule({}, "notes", operation, { id: "internal", provider: "internal", roles: [] })).toEqual({
				allowed: false,
				code: "forbidden",
			});
		}
	});

	it("denies on false, throwing and non-boolean rules", async () => {
		const auth = { id: "internal", provider: "internal", roles: [] };
		const throwing = () => {
			throw new Error("boom");
		};
		const truthy = (() => "yes") as unknown as () => boolean;
		expect((await evaluateRule({ view: deny }, "notes", "view", auth)).allowed).toBe(false);
		expect((await evaluateRule({ view: throwing }, "notes", "view", auth)).allowed).toBe(false);
		expect((await evaluateRule({ view: truthy }, "notes", "view", auth)).allowed).toBe(false);
		expect((await evaluateRule({ view: authenticated }, "notes", "view", null)).allowed).toBe(false);
		expect((await evaluateRule({ view: authenticated }, "notes", "view", auth)).allowed).toBe(true);
	});

	it("ignores inherited rule names", async () => {
		const rules = Object.create({ view: () => true });
		expect(
			(await evaluateRule(rules, "notes", "view", { id: "internal", provider: "internal", roles: [] })).allowed,
		).toBe(false);
	});
});

describe("defineCollection", () => {
	it("names the collection after its table and compiles its rules", () => {
		const collection = defineCollection({ table: notes, rules: {}, validate: { title: "required|string" } });
		expect(collection.name).toBe("notes");
		expect(collection.validation.title?.required).toBe(true);
		expect(Object.isFrozen(collection)).toBe(true);
	});

	it("rejects invalid names, missing server columns and unknown or server-owned fields", () => {
		expect(() => defineCollection({ table: notes, name: "Notes; --", rules: {}, validate: {} })).toThrow(/name/);
		const bare = sqliteTable("bare", { ...id(), title: text("title") });
		expect(() => defineCollection({ table: bare, rules: {}, validate: {} })).toThrow(/"created" column/);
		expect(() => defineCollection({ table: notes, rules: {}, validate: { missing: "string" } })).toThrow(
			/unknown column/,
		);
		expect(() => defineCollection({ table: notes, rules: {}, validate: { id: "string" } })).toThrow(/server-owned/);
	});

	it("binds unique and exists rules to known tables and columns at startup", () => {
		const agents = sqliteTable("agents", { id: text("id").primaryKey(), code: text("code") });
		const withRules = (validate: Record<string, string>) => defineCollection({ table: notes, rules: {}, validate });
		const registry = createCollectionRegistry([withRules({ title: "unique", rank: "exists:agents,code" })], {
			tables: [agents],
		});
		const compiled = registry.get("notes")?.validation;
		const unique = compiled?.title?.database[0];
		const exists = compiled?.rank?.database[0];
		expect(unique && registry.lookup(unique)).toMatchObject({ table: notes, ignoreCurrent: true });
		expect(exists && registry.lookup(exists)).toMatchObject({ table: agents, ignoreCurrent: false });
		expect(exists && registry.lookup(exists)?.column.name).toBe("code");

		expect(() => createCollectionRegistry([withRules({ rank: "exists:agents,id" })])).toThrow(/unknown table "agents"/);
		expect(() => createCollectionRegistry([withRules({ title: "unique:notes,missing" })])).toThrow(/unknown column/);
		expect(() =>
			createCollectionRegistry([withRules({ rank: "exists:sqlite_master,name" })], { tables: [agents] }),
		).toThrow(/unknown table/);
	});

	it("registers each collection name once", () => {
		const collection = defineCollection({ table: notes, rules: {}, validate: {} });
		const registry = createCollectionRegistry([collection]);
		expect(registry.get("notes")).toBe(collection);
		expect(registry.get("constructor")).toBeUndefined();
		expect(() => createCollectionRegistry([collection, collection])).toThrow(/defined twice/);
	});
});
