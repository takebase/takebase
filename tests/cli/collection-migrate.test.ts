import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "@takebase/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseJsonc } from "../../packages/cli/src/jsonc.ts";

// A disposable Worker using the tenant example's installed (pinned) wrangler,
// drizzle-kit, drizzle-orm and @takebase/core. Its local D1 state lives in a
// temporary --persist-to directory; nothing touches real data or remote D1.
const tenantModules = fileURLToPath(new URL("../../examples/workers/tenant/node_modules", import.meta.url));

let root: string;
let worker: string;
let state: string;

const cli = (...argv: string[]) => {
	const out = { stdout: "", stderr: "" };
	const code = run(argv, {
		stdout: (text) => {
			out.stdout += text;
		},
		stderr: (text) => {
			out.stderr += text;
		},
		cwd: worker,
	});
	return { code, ...out };
};
const local = ["--persist-to", "../state"];

// Direct SQL on the disposable database, through the same pinned Wrangler.
const execute = (sql: string) => {
	const result = spawnSync(
		join(worker, "node_modules/.bin/wrangler"),
		["d1", "execute", "DB", "--local", "--persist-to", state, "--json", "--command", sql],
		{ cwd: worker, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	expect(result.status, result.stderr).toBe(0);
	return (JSON.parse(result.stdout.slice(result.stdout.indexOf("["))) as { results: Record<string, unknown>[] }[])[0]
		?.results;
};

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "takebase-migrate-"));
	worker = join(root, "worker");
	state = join(root, "state");
	mkdirSync(join(worker, "src"), { recursive: true });
	symlinkSync(tenantModules, join(worker, "node_modules"), "dir");
	writeFileSync(
		join(worker, "wrangler.jsonc"),
		`{
	// Disposable test Worker.
	"name": "takebase-migrate-test",
	"main": "src/index.ts",
	"compatibility_date": "2026-10-19",
	"d1_databases": [{ "binding": "DB", "database_name": "test", "database_id": "local-test", "migrations_dir": "migrations" }],
	"env": { "tenant-x": { "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "local-x", "migrations_dir": "migrations" }] } },
}
`,
	);
	writeFileSync(
		join(worker, "drizzle.config.ts"),
		`import { defineConfig } from "drizzle-kit";\n\nexport default defineConfig({ dialect: "sqlite", schema: "./src/schema", out: "./migrations" });\n`,
	);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("takebase collection + migrate on a disposable local tenant D1 (S-2-3-01)", () => {
	it("generates a deny-by-default collection and refuses to overwrite it", () => {
		const created = cli(
			"collection",
			"create",
			"claims",
			"--field",
			"title:text",
			"--field",
			"amount:integer?",
			"--field",
			"paid:boolean",
		);
		expect(created).toMatchObject({ code: 0, stderr: "" });
		expect(created.stdout).toContain("src/schema/claims.ts");
		expect(created.stdout).toContain("Register claimsCollection in src/collections/index.ts");

		const schema = readFileSync(join(worker, "src/schema/claims.ts"), "utf8");
		expect(schema).toContain(`title: text("title").notNull(),`);
		expect(schema).toContain(`amount: integer("amount"),`);
		expect(schema).toContain(`paid: integer("paid", { mode: "boolean" }).notNull(),`);
		const collection = readFileSync(join(worker, "src/collections/claims.ts"), "utf8");
		expect(collection).toContain("rules: {},");
		expect(collection).toContain(`amount: "nullable|integer",`);

		const again = cli("collection", "create", "claims", "--field", "title:text");
		expect(again.code).toBe(1);
		expect(again.stderr).toContain("Refusing to overwrite");
		expect(readFileSync(join(worker, "src/schema/claims.ts"), "utf8")).toBe(schema);

		writeFileSync(
			join(worker, "src/collections/index.ts"),
			`import { createCollectionRegistry } from "@takebase/core";\nimport { claimsCollection } from "./claims.ts";\n\nexport const collections = createCollectionRegistry([claimsCollection]);\n`,
		);
		const inspected = cli("collection", "inspect", "claims");
		expect(inspected).toMatchObject({ code: 0, stderr: "" });
		expect(inspected.stdout).toMatch(/^ {2}create {2}denied \(no rule\)$/m);
		expect(inspected.stdout).toMatch(/^ {2}paid +integer +not null +required\|boolean$/m);
		expect(inspected.stdout).toMatch(/^ {2}id +text +primary key +\(server-owned\)$/m);
		expect(cli("collection", "inspect", "missing")).toMatchObject({
			code: 1,
			stderr: expect.stringContaining("Registered: claims"),
		});
	});

	it("generates reviewable SQL, applies it to a new database and reruns safely", () => {
		const generated = cli("migrate", "generate", "--name", "create_claims");
		expect(generated).toMatchObject({ code: 0, stderr: "" });
		expect(generated.stdout).toContain("migrations/0000_create_claims.sql");
		expect(cli("migrate", "generate", "--name", "again").stdout).toContain("No schema changes");

		const pending = cli("migrate", "inspect", "--sql", ...local);
		expect(pending.code).toBe(0);
		expect(pending.stdout).toContain("pending  0000_create_claims.sql");
		expect(pending.stdout).toContain("0 applied, 1 pending.");
		expect(pending.stdout).toContain("CREATE TABLE `claims`");

		const applied = cli("migrate", "apply", ...local);
		expect(applied).toMatchObject({ code: 0, stderr: "" });
		expect(applied.stdout).toContain("Applied to DB (local) in the current directory:\n  0000_create_claims.sql");
		expect(cli("migrate", "apply", ...local)).toMatchObject({
			code: 0,
			stdout: expect.stringContaining("Nothing to migrate"),
		});
		expect(cli("migrate", "inspect", ...local).stdout).toContain("1 applied, 0 pending.");

		// Another Wrangler environment is a different database with its own history.
		expect(cli("migrate", "inspect", "--env", "tenant-x", ...local).stdout).toContain("0 applied, 1 pending.");
	}, 120_000);

	it("reports a failed migration as failed and leaves it pending", () => {
		// SQLite rejects adding a NOT NULL column without a default once the table has rows.
		execute("INSERT INTO claims (id, title, paid, created, updated) VALUES ('c1', 'Water damage', 0, 'now', 'now')");
		const schema = join(worker, "src/schema/claims.ts");
		writeFileSync(
			schema,
			readFileSync(schema, "utf8").replace("\t...timestamps(),", `\tref: text("ref").notNull(),\n\t...timestamps(),`),
		);
		expect(cli("migrate", "generate", "--name", "add_ref").code).toBe(0);
		expect(existsSync(join(worker, "migrations/0001_add_ref.sql"))).toBe(true);

		const failed = cli("migrate", "apply", ...local);
		expect(failed.code).toBe(1);
		expect(failed.stdout).toBe("");
		expect(failed.stderr).toContain("Migration 0001_add_ref.sql failed and was rolled back; it is still pending.");
		const after = cli("migrate", "inspect", ...local);
		expect(after.stdout).toContain("applied  0000_create_claims.sql");
		expect(after.stdout).toContain("pending  0001_add_ref.sql");
		// Rolled back: the row is intact and the column was not added.
		expect(execute("SELECT * FROM claims")).toEqual([
			{ id: "c1", title: "Water damage", amount: null, paid: 0, created: "now", updated: "now" },
		]);
	}, 120_000);

	it("refuses to apply when the files no longer match the applied history", () => {
		const applied = join(worker, "migrations/0000_create_claims.sql");
		const moved = join(root, "0000_create_claims.sql");
		renameSync(applied, moved);
		for (const command of ["inspect", "apply"]) {
			const result = cli("migrate", command, ...local);
			expect(result.code, command).toBe(1);
			expect(result.stderr).toContain("0000_create_claims.sql was applied but its file is missing");
			expect(result.stderr).toContain("never rewrite applied migrations");
		}
		renameSync(moved, applied);

		const stray = join(worker, "migrations/0002_hand_written.sql");
		writeFileSync(stray, "CREATE TABLE notes (id text);\n");
		const unjournaled = cli("migrate", "apply", ...local);
		expect(unjournaled.code).toBe(1);
		expect(unjournaled.stderr).toContain("0002_hand_written.sql is not in meta/_journal.json");
		rmSync(stray);
		expect(cli("migrate", "inspect", ...local).stdout).toContain("1 applied, 1 pending.");
	}, 120_000);
});

describe("takebase migrate and collection arguments", () => {
	it("only targets local databases and explains how to pick one", () => {
		expect(cli("migrate", "apply", "--remote")).toMatchObject({
			code: 1,
			stderr: expect.stringContaining("Remote migrations are not supported"),
		});
		expect(cli("migrate", "inspect", "--env", "nope")).toMatchObject({
			code: 1,
			stderr: expect.stringContaining(`Wrangler environment "nope" is not defined`),
		});
		expect(cli("migrate", "inspect", "--database", "OTHER")).toMatchObject({
			code: 1,
			stderr: expect.stringContaining("Bindings: DB."),
		});
		expect(cli("migrate", "inspect", "--worker", "..")).toMatchObject({
			code: 1,
			stderr: expect.stringContaining("No wrangler.jsonc"),
		});
	});

	it("rejects malformed commands, names and fields as usage errors", () => {
		for (const argv of [
			["migrate"],
			["migrate", "rollback"],
			["migrate", "generate"],
			["migrate", "generate", "--name", "Bad Name"],
			["migrate", "apply", "--sql"],
			["migrate", "inspect", "--name", "x"],
			["collection"],
			["collection", "create"],
			["collection", "create", "Claims", "--field", "a:text"],
			["collection", "create", "claims2"],
			["collection", "create", "claims2", "--field", "a:string"],
			["collection", "create", "claims2", "--field", "id:text"],
			["collection", "create", "claims2", "--field", "a:text", "--field", "a:integer"],
			["collection", "inspect", "claims", "--field", "a:text"],
		]) {
			expect(cli(...argv).code, argv.join(" ")).toBe(2);
		}
		expect(existsSync(join(worker, "src/schema/claims2.ts"))).toBe(false);
		expect(cli("migrate", "--help")).toMatchObject({
			code: 0,
			stdout: expect.stringContaining("Only local databases"),
		});
		expect(cli("collection", "--help").stdout).toContain("every operation is denied");
	});
});

describe("parseJsonc", () => {
	it("reads wrangler.jsonc comments and trailing commas but keeps string contents", () => {
		expect(
			parseJsonc(`{
				// line comment "not a string"
				"a": "http://x/*y*/,}", /* block */ "b": [1, 2,],
				"c": "quote \\" // still a string",
			}`),
		).toEqual({ a: "http://x/*y*/,}", b: [1, 2], c: 'quote " // still a string' });
		expect(() => parseJsonc("{ a: 1 }")).toThrow();
	});
});
