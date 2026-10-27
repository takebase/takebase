import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hookOutput, runAfterHook } from "../src/collections/hooks.ts";
import { defineCollection, HookError, id, timestamps } from "../src/index.ts";

const notes = sqliteTable("notes", { ...id(), title: text("title").notNull(), ...timestamps() });

describe("collection hooks", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("are checked when the collection is defined", () => {
		const creating = (data: Record<string, unknown>) => data;
		const collection = defineCollection({
			table: notes,
			rules: {},
			validate: { title: "string" },
			hooks: { creating },
		});
		expect(collection.hooks.creating).toBe(creating);
		expect(Object.isFrozen(collection.hooks)).toBe(true);
		expect(defineCollection({ table: notes, rules: {}, validate: {} }).hooks).toEqual({});

		const unknownHook = JSON.parse(`{"saving":null}`);
		expect(() => defineCollection({ table: notes, rules: {}, validate: {}, hooks: unknownHook })).toThrow(
			/unknown hook "saving"/,
		);
		const notAFunction = { created: "log" } as unknown as { created: () => void };
		expect(() => defineCollection({ table: notes, rules: {}, validate: {}, hooks: notAFunction })).toThrow(
			/must be a function/,
		);
	});

	it("accept only client-writable fields from a before-hook", () => {
		const data = { title: "a" };
		expect(hookOutput("notes", "creating", undefined, data, ["title"])).toBe(data);
		expect(hookOutput("notes", "creating", { title: "b" }, data, ["title"])).toEqual({ title: "b" });
		for (const result of [{ id: "x" }, { title: "b", created: "2030" }, { body: "x" }]) {
			expect(() => hookOutput("notes", "creating", result, data, ["title"])).toThrow(/non-writable fields/);
		}
		for (const result of [null, [], "title", new Map()]) {
			expect(() => hookOutput("notes", "creating", result as never, data, ["title"])).toThrow(/plain object/);
		}
	});

	it("log after-hook failures instead of failing the committed write", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			runAfterHook("notes", "created", () => {
				throw new Error("mail down");
			}),
		).resolves.toBeUndefined();
		await expect(runAfterHook("notes", "created", async () => Promise.reject(new Error("x")))).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			event: "collection.hook_failed",
			collection: "notes",
			hook: "created",
			error: { message: "mail down" },
		});
	});

	it("reject operations with a client error code and optional field messages", () => {
		const error = new HookError("validation_failed", "Holder is blocked", { holder: "The holder is blocked." });
		expect(error).toMatchObject({
			name: "HookError",
			code: "validation_failed",
			fields: { holder: "The holder is blocked." },
		});
		expect(new HookError("conflict", "Has claims").fields).toBeUndefined();
	});
});
