import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Consumer, installConsumer, packed, sh, tarballName } from "./consumer.ts";

// S-7-3-01: what a consumer gets from `pnpm pack`, installed outside the workspace.

let consumer: Consumer;

const tarball = (name: (typeof packed)[number]) => join(consumer.packs, tarballName(name));
const contents = (name: (typeof packed)[number]) =>
	sh(consumer.packs, "tar", ["-tzf", tarball(name)])
		.stdout.split("\n")
		.filter((path) => path !== "");
const manifest = (name: (typeof packed)[number]) =>
	sh(consumer.packs, "tar", ["-xzOf", tarball(name), "package/package.json"]).stdout;

const unwanted =
	/(^|\/)(\.env[^/]*|\.dev\.vars[^/]*|\.DS_Store|\.wrangler|\.git|node_modules|escrow)(\/|$)|\.(pem|key|p12)$/;
const secretText = /-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30,}|"private_key"\s*:/;

beforeAll(() => {
	consumer = installConsumer();
});

afterAll(() => {
	consumer?.remove();
});

describe("package contents", () => {
	it.each(packed)("%s ships built files only, with no secrets", (name) => {
		const files = contents(name);
		expect(files.filter((file) => unwanted.test(file))).toEqual([]);
		const shipped = files.filter((file) => !file.startsWith("package/dist/") && !file.startsWith("package/templates/"));
		expect(shipped.filter((file) => file !== "package/README.md")).toEqual(["package/package.json"]);
		expect(files.some((file) => file.startsWith("package/dist/") && file.endsWith(".js"))).toBe(true);
		const text = sh(consumer.packs, "tar", ["-xzOf", tarball(name)]).stdout;
		expect(secretText.test(text)).toBe(false);
	});

	it.each(packed)("%s has a manifest a consumer can resolve", (name) => {
		const text = manifest(name);
		expect(text).not.toContain("workspace:");
		expect(text).not.toContain("./src/");
	});
});

describe("installed packages", () => {
	it("the CLI runs and generates a starter from its own templates", () => {
		const bin = join(consumer.dir, "node_modules", ".bin", "takebase");
		expect(sh(consumer.dir, bin, ["--version"]).stdout.trim()).toBe("0.0.0");
		const help = sh(consumer.dir, bin, ["--help"]);
		expect(help.code).toBe(0);
		expect(help.stdout).toContain("secrets");
		const created = sh(consumer.dir, bin, ["create", "generated-app"]);
		expect(created.stderr).toBe("");
		expect(created.code).toBe(0);
		expect(readFileSync(join(consumer.dir, "generated-app", "package.json"), "utf8")).toContain('"generated-app"');
	});

	it("the packages load in Node", () => {
		const script = join(consumer.dir, "load.mjs");
		writeFileSync(
			script,
			`const sdk = await import("@takebase/sdk");
const core = await import("@takebase/core");
const adapter = await import("@takebase/adapter-firebase");
const rules = await import("@takebase/adapter-firebase/rules");
console.log(typeof sdk.createClient, typeof core.defineCollection, typeof adapter.firebaseRealtime, typeof rules.databaseRules);
`,
		);
		const result = sh(consumer.dir, process.execPath, [script]);
		expect(result.stderr).toBe("");
		expect(result.stdout.trim()).toBe("function function function function");
	});

	it("the packages compile for a consumer with no Node types and no source exports", () => {
		writeFileSync(
			join(consumer.dir, "compile.ts"),
			`import { createFirebaseRealtime } from "@takebase/adapter-firebase";
import { defineCollection } from "@takebase/core";
import { createClient } from "@takebase/sdk";
export { createClient, createFirebaseRealtime, defineCollection };
`,
		);
		writeFileSync(
			join(consumer.dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2023",
					module: "ESNext",
					moduleResolution: "Bundler",
					lib: ["ES2023", "DOM"],
					strict: true,
					skipLibCheck: true,
					noEmit: true,
					types: [],
				},
				files: ["compile.ts"],
			}),
		);
		const result = sh(consumer.dir, join(consumer.dir, "node_modules", ".bin", "tsc"), ["-p", "."]);
		expect(result.stdout).toBe("");
		expect(result.code).toBe(0);
	});

	// S-7-3-01: defining and using a collection without importing the ORM. The
	// consumer's own code never names it; drizzle-kit is only a generator it runs.
	describe("a collection defined by the consumer", () => {
		const cli = (...args: string[]) => sh(consumer.dir, join(consumer.dir, "node_modules", ".bin", "takebase"), args);

		beforeAll(() => {
			writeFileSync(
				join(consumer.dir, "wrangler.jsonc"),
				JSON.stringify({
					name: "takebase-consumer",
					main: "src/index.ts",
					compatibility_date: "2026-10-19",
					d1_databases: [{ binding: "DB", database_name: "db", database_id: "local", migrations_dir: "migrations" }],
				}),
			);
			writeFileSync(
				join(consumer.dir, "drizzle.config.ts"),
				'import { defineConfig } from "drizzle-kit";\n\nexport default defineConfig({ dialect: "sqlite", schema: "./src/schema", out: "./migrations" });\n',
			);
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
			if (created.code !== 0) throw new Error(created.stderr);
			writeFileSync(
				join(consumer.dir, "src/collections/index.ts"),
				'import { createCollectionRegistry } from "@takebase/core";\nimport { claimsCollection } from "./claims.ts";\n\nexport const collections = createCollectionRegistry([claimsCollection]);\n',
			);
			writeFileSync(
				join(consumer.dir, "src/client.ts"),
				`import type { CollectionFields } from "@takebase/core/schema";
import type { TakebaseClient } from "@takebase/sdk";
import type { claims } from "./schema/claims.ts";

export const addClaim = async (client: TakebaseClient) => {
	const collection = client.collection<CollectionFields<typeof claims>>("claims");
	const record = await collection.create({ title: "Hail", amount: null, paid: false });
	const title: string = record.title;
	const paid: boolean = record.paid;
	// @ts-expect-error A boolean field refuses a string, so the types really flow from the table.
	await collection.create({ title: "Hail", amount: null, paid: "no" });
	return { title, paid };
};
`,
			);
		});

		it("compiles with typed fields", () => {
			writeFileSync(
				join(consumer.dir, "tsconfig.collection.json"),
				JSON.stringify({
					compilerOptions: {
						target: "ES2023",
						module: "ESNext",
						moduleResolution: "Bundler",
						lib: ["ES2023", "DOM"],
						strict: true,
						skipLibCheck: true,
						noEmit: true,
						allowImportingTsExtensions: true,
						types: [],
					},
					include: ["src"],
				}),
			);
			const result = sh(consumer.dir, join(consumer.dir, "node_modules", ".bin", "tsc"), [
				"-p",
				"tsconfig.collection.json",
			]);
			expect(result.stdout).toBe("");
			expect(result.code).toBe(0);
		});

		it("never imports the ORM in its own source", () => {
			const sources = readdirSync(join(consumer.dir, "src"), { recursive: true, withFileTypes: true }).filter((entry) =>
				entry.isFile(),
			);
			expect(sources.length).toBeGreaterThanOrEqual(4);
			for (const entry of sources) {
				expect(readFileSync(join(entry.parentPath, entry.name), "utf8"), entry.name).not.toMatch(/drizzle/i);
			}
		});

		it("is inspected and migrated through the installed CLI", () => {
			const inspected = cli("collection", "inspect", "claims");
			expect(inspected.stderr).toBe("");
			expect(inspected.stdout).toContain("title");
			const generated = cli("migrate", "generate", "--name", "create_claims");
			expect(generated.stderr).toBe("");
			expect(generated.code).toBe(0);
			const sql = readdirSync(join(consumer.dir, "migrations")).find((file) => file.endsWith(".sql"));
			expect(sql).toBeDefined();
			expect(readFileSync(join(consumer.dir, "migrations", sql ?? ""), "utf8")).toContain("CREATE TABLE `claims`");
		});
	});
});
