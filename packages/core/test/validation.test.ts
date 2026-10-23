import { describe, expect, it } from "vitest";
import { compileRules, defaultMessages, formatMessage, validate } from "../src/index.ts";

const rules = compileRules({
	title: "required|string|min:3|max:20",
	status: "required|in:draft,active,archived",
	notes: "nullable|string|max:10",
	score: ["sometimes", "integer", "min:0", "max:100"],
	contact: "email",
	code: ["required", "regex:/^[A-Z]{2}-\\d+|X$/"],
});
const valid = { title: "Fire cover", status: "draft", code: "AB-12" };

describe("Laravel-style validation", async () => {
	it("accepts valid input and returns only declared fields", async () => {
		expect(await validate({ ...valid, notes: null, score: 7 }, rules, { mode: "create" })).toEqual({
			ok: true,
			data: { ...valid, notes: null, score: 7 },
		});
	});

	it("requires required fields on create and reports one message per field", async () => {
		const result = await validate({}, rules, { mode: "create" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.fields).toEqual({
			title: "The title field is required.",
			status: "The status field is required.",
			code: "The code field is required.",
		});
		expect(result.failures.title).toEqual({ key: "required", params: {} });
	});

	it("checks only sent fields on update", async () => {
		expect(await validate({ status: "active" }, rules, { mode: "update" })).toEqual({
			ok: true,
			data: { status: "active" },
		});
		expect((await validate({ title: "" }, rules, { mode: "update" })).ok).toBe(false);
	});

	it("prohibits undeclared and server-owned fields", async () => {
		const result = await validate({ ...valid, id: "x", created: "now", "title; drop table": 1 }, rules, {
			mode: "create",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(Object.keys(result.fields).sort()).toEqual(["created", "id", "title; drop table"]);
		expect(result.fields.id).toBe("The id field is prohibited.");
	});

	it("applies type, size, list, format and pattern rules", async () => {
		const fields = async (input: Record<string, unknown>) => {
			const result = await validate({ ...valid, ...input }, rules, { mode: "create" });
			return result.ok ? {} : result.fields;
		};
		expect(await fields({ title: "ab" })).toEqual({ title: "The title field must be at least 3 characters." });
		expect(await fields({ title: 42 })).toEqual({ title: "The title field must be a string." });
		expect(await fields({ status: "deleted" })).toEqual({ status: "The selected status is invalid." });
		expect(await fields({ score: 101 })).toEqual({ score: "The score field must not be greater than 100." });
		expect(await fields({ score: 1.5 })).toEqual({ score: "The score field must be an integer." });
		expect(await fields({ notes: "x".repeat(11) })).toEqual({
			notes: "The notes field must not be greater than 10 characters.",
		});
		expect(await fields({ contact: "nope" })).toEqual({ contact: "The contact field must be a valid email address." });
		expect(await fields({ code: "ab-12" })).toEqual({ code: "The code field format is invalid." });
		expect(await fields({ code: "X" })).toEqual({});
		expect(await fields({ title: null })).toEqual({ title: "The title field is required." });
		expect(await fields({ contact: null })).toEqual({ contact: "The contact field must be a valid email address." });
	});

	it("renders messages from a replaceable catalog with attribute names", async () => {
		const result = await validate({ status: "draft", code: "AB-1" }, rules, {
			mode: "create",
			messages: { required: "El campo :attribute es obligatorio." },
			attributes: { title: "título" },
		});
		expect(result.ok ? null : result.fields.title).toBe("El campo título es obligatorio.");
		expect(formatMessage("start_date", { key: "date", params: {} })).toBe("The start date field must be a valid date.");
		expect(defaultMessages["max.string"]).toContain(":max");
	});

	it("rejects unknown or malformed rules when compiling", async () => {
		expect(() => compileRules({ title: "required|distinct" })).toThrow(/Unknown validation rule "distinct"/);
		expect(() => compileRules({ agent: "exists" })).toThrow(/needs a table/);
		expect(() => compileRules({ agent: "exists:agents;drop,id" })).toThrow(/table/);
		expect(() => compileRules({ agent: "unique:a,b,c" })).toThrow(/table/);
		expect(() => compileRules({ title: "max:abc" })).toThrow(/needs a number/);
		expect(() => compileRules({ title: "string:5" })).toThrow(/takes no arguments/);
		expect(() => compileRules({ title: "regex:abc" })).toThrow(/pattern/);
	});

	it("rejects non-object input", async () => {
		await expect(validate([], rules, { mode: "create" })).rejects.toThrow(TypeError);
	});

	it("runs unique and exists through the lookup after the other rules pass", async () => {
		const databaseRules = compileRules({
			number: "required|string|max:5|unique",
			agent_id: "nullable|string|exists:agents,id",
		});
		const calls: string[] = [];
		const lookup = async (field: string, rule: { name: string }, value: unknown) => {
			calls.push(`${rule.name}:${field}=${String(value)}`);
			return rule.name === "unique" ? value !== "TAKEN" : value === "agent-1";
		};
		const run = (input: Record<string, unknown>) => validate(input, databaseRules, { mode: "create", lookup });

		expect(await run({ number: "OK", agent_id: "agent-1" })).toEqual({
			ok: true,
			data: { number: "OK", agent_id: "agent-1" },
		});
		const failed = await run({ number: "TAKEN", agent_id: "nobody" });
		expect(failed.ok ? {} : failed.fields).toEqual({
			number: "The number has already been taken.",
			agent_id: "The selected agent id is invalid.",
		});

		calls.length = 0;
		await run({ number: "TOO-LONG", agent_id: null });
		expect(calls).toEqual([]);
		await expect(validate({ number: "OK" }, databaseRules, { mode: "create" })).rejects.toThrow(/no database lookup/);
	});
});
