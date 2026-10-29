import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupCommand } from "../../packages/cli/src/commands/backup.ts";
import type { CliIo } from "../../packages/cli/src/errors.ts";
import type { RemoteDeps } from "../../packages/cli/src/services/remote-workers.ts";
import { importDataKey, sealEnvelope } from "../../packages/cli/src/services/secret-envelopes.ts";
import { randomKey, randomValue } from "../fixtures/secret-store.ts";

// `takebase backup create|list|verify` (SEGU-225) on a throwaway remote
// project. Wrangler is a FAKE: D1 exports, KV and R2 in memory, answering the
// calls the CLI makes. It proves coverage, account pinning and that nothing
// secret is written or printed, not that Cloudflare accepts the calls (that is
// the smoke journey with real local Wrangler, and staging). Keys and values
// are random per run.

const account = "acct-pinned";
let root: string;

const write = (path: string, text: string) => {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
};

const sql = (migrations: string[], table: string) =>
	[
		"PRAGMA defer_foreign_keys=TRUE;",
		'CREATE TABLE IF NOT EXISTS "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);',
		...migrations.map((name, i) => `INSERT INTO "d1_migrations" ("id","name") VALUES(${i + 1},'${name}');`),
		`CREATE TABLE \`${table}\` (\`id\` text PRIMARY KEY NOT NULL);`,
		`INSERT INTO "${table}" ("id") VALUES('row-1');`,
		`CREATE TRIGGER \`${table}_no_delete\` BEFORE DELETE ON \`${table}\` BEGIN SELECT RAISE(ABORT, 'no'); END;`,
	].join("\n");

const globalMigrations = ["0000_tenants.sql", "0001_access.sql"];
const tenantMigrations = ["0000_policies.sql"];

const project = (bucket: string, secrets: Record<string, string>) => {
	write(
		"takebase.jsonc",
		JSON.stringify({
			workers: { global: "global", tenant: "tenant", app: "app" },
			environments: {
				staging: {
					remote: true,
					firebaseProject: "takebase-test",
					namePrefix: "takebase-staging-",
					workersSubdomain: "sub",
					globalEnv: "staging",
					appEnv: "staging",
					secretsFile: "secrets.env",
					backupBucket: bucket,
					dispatcherPasswordKey: "PASSWORD_DISPATCHER_{TENANT}",
					dispatcherEmail: "dispatcher-{tenant}@example.test",
					tenants: {
						"tenant-a": { name: "A", env: "staging-tenant-a" },
						"tenant-b": { name: "B", env: "staging-tenant-b" },
					},
				},
			},
		}),
	);
	write(
		"secrets.env",
		`${Object.entries(secrets)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n")}\n`,
	);
	const d1 = (name: string, dir: string) => [
		{ binding: "DB", database_name: name, database_id: `id-${name}`, migrations_dir: dir },
	];
	write(
		"global/wrangler.jsonc",
		JSON.stringify({
			name: "example-global",
			env: {
				staging: {
					name: "takebase-staging-global",
					vars: { TAKEBASE_ENV: "staging" },
					d1_databases: d1("takebase-staging-global", "../migrations/global"),
				},
			},
		}),
	);
	const tenantEnv = (id: string) => ({
		name: `takebase-staging-${id}`,
		vars: { TENANT_ID: id, TAKEBASE_ENV: "staging", DATA_KEY_VERSION: "2", FIREBASE_API_KEY: secrets.FIREBASE_API_KEY },
		d1_databases: d1(`takebase-staging-${id}`, "../migrations/tenant"),
		kv_namespaces: [{ binding: "SECRETS", id: `kv-${id}` }],
	});
	write(
		"tenant/wrangler.jsonc",
		JSON.stringify({
			name: "example-tenant",
			env: { "staging-tenant-a": tenantEnv("tenant-a"), "staging-tenant-b": tenantEnv("tenant-b") },
		}),
	);
	for (const name of globalMigrations) write(`migrations/global/${name}`, `-- ${name}\n`);
	for (const name of tenantMigrations) write(`migrations/tenant/${name}`, `-- ${name}\n`);
};

// A fake Wrangler: D1 exports, each tenant's KV and one R2 bucket in memory.
const fakeCloudflare = (kv: Record<string, Map<string, { value: string; metadata: unknown }>>) => {
	const r2 = new Map<string, Buffer>();
	const calls: { args: string[]; env: Record<string, string> | undefined }[] = [];
	const ok = (stdout = "") => ({ status: 0, stdout, output: stdout });
	const flag = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? "";
	const deps: RemoteDeps = {
		run: (_dir, tool, args, env) => {
			calls.push({ args, env });
			if (tool !== "wrangler") throw new Error(`unexpected tool ${tool}`);
			if (args[0] === "whoami") return ok(JSON.stringify({ loggedIn: true, accounts: [{ id: account }] }));
			if (args[0] === "d1" && args[1] === "export") {
				const env = flag(args, "--env");
				const text = env === "staging" ? sql(globalMigrations, "tenants") : sql(tenantMigrations, "policies");
				writeFileSync(flag(args, "--output"), text);
				return ok("Done!");
			}
			if (args[0] === "kv") {
				const namespace = kv[flag(args, "--env")] ?? new Map();
				if (args[2] === "list") {
					return ok(JSON.stringify([...namespace].map(([name, { metadata }]) => ({ name, metadata }))));
				}
				if (args[2] === "get") return ok(namespace.get(args[3] ?? "")?.value ?? "Value not found");
			}
			if (args[0] === "r2" && args[1] === "object") {
				const key = args[3] ?? "";
				if (args[2] === "put") {
					r2.set(key, readFileSync(flag(args, "--file")));
					return ok("Upload complete.");
				}
				if (args[2] === "get") {
					const bytes = r2.get(key);
					if (bytes === undefined) return { status: 1, stdout: "", output: "The specified key does not exist." };
					writeFileSync(flag(args, "--file"), bytes);
					return ok("Download complete.");
				}
			}
			throw new Error(`unexpected wrangler ${args.join(" ")}`);
		},
		fetch: () => Promise.reject(new Error("no network")),
		wait: async () => {},
	};
	return { deps, r2, calls };
};

const io = () => {
	const out: string[] = [];
	const value: CliIo = { stdout: (text) => out.push(text), stderr: (text) => out.push(text), cwd: root };
	return { io: value, text: () => out.join("") };
};

const secretsKv = async (key: string, plaintexts: string[]) => {
	const dataKey = await importDataKey(key);
	const map = new Map<string, { value: string; metadata: unknown }>();
	for (const [i, plaintext] of plaintexts.entries()) {
		const binding = { tenantId: "tenant-a", environment: "staging", keyVersion: 2, purpose: "smtp", name: `n${i}` };
		map.set(`secret/smtp/n${i}`, {
			value: await sealEnvelope(dataKey, binding, new TextEncoder().encode(plaintext)),
			metadata: { kv: 2, updated: "2026-10-28T00:00:00.000Z" },
		});
	}
	return map;
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "takebase-backup-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("takebase backup create (S-6-3-01 coverage)", () => {
	it("backs up a tenant, the global database and everything, each with matching manifest coverage", async () => {
		const secrets = { CLOUDFLARE_ACCOUNT_ID: account, FIREBASE_API_KEY: randomValue() };
		project("takebase-staging-backups", secrets);
		const cf = fakeCloudflare({
			"staging-tenant-a": await secretsKv(randomKey(), [randomValue(), randomValue(), randomValue()]),
			"staging-tenant-b": new Map(),
		});
		const run = async (...args: string[]) => {
			const out = io();
			const code = await backupCommand([...args, "--env", "staging"], out.io, cf.deps);
			return { code, text: out.text() };
		};
		const manifests = [];
		for (const selection of [["--tenant", "tenant-a"], ["--global"], ["--all"]]) {
			const created = await run("create", ...selection);
			expect(created.code, created.text).toBe(0);
			expect(created.text).toMatch(/: verified\n$/);
			const key = [...cf.r2.keys()].filter((name) => name.endsWith("/manifest.json")).at(-1) ?? "";
			manifests.push(JSON.parse(String(cf.r2.get(key))));
			// Backup ids have one-second resolution.
			await new Promise((resolve) => setTimeout(resolve, 1_050));
		}
		const coverage = (manifest: {
			parts: {
				kind: string;
				target: string;
				schemaVersion?: string;
				count?: number;
				keyVersions?: number[];
				migrations?: { sha256: string | null }[];
			}[];
		}) =>
			manifest.parts.map(({ kind, target, schemaVersion, count, keyVersions, migrations }) => ({
				kind,
				target,
				schemaVersion,
				count,
				keyVersions,
				hashed: migrations?.every((migration) => migration.sha256 !== null),
			}));
		const tenantA = [
			{ kind: "d1", target: "tenant:tenant-a", schemaVersion: "0000_policies.sql", hashed: true },
			{ kind: "kv", target: "tenant:tenant-a", count: 3, keyVersions: [2] },
		];
		const global = { kind: "d1", target: "global", schemaVersion: "0001_access.sql", hashed: true };
		const config = { kind: "config", target: "environment" };
		expect(manifests.map((manifest) => [manifest.scope, coverage(manifest)])).toEqual([
			["tenant", [...tenantA, config]],
			["global", [global, config]],
			[
				"all",
				[
					global,
					...tenantA,
					{ kind: "d1", target: "tenant:tenant-b", schemaVersion: "0000_policies.sql", hashed: true },
					{ kind: "kv", target: "tenant:tenant-b", count: 0, keyVersions: [] },
					config,
				],
			],
		]);
		const listed = await run("list");
		expect(listed.code).toBe(0);
		expect(listed.text.match(/ verified\n/g)).toHaveLength(3);
		// Every Wrangler call is pinned to the environment's account.
		expect(cf.calls.every(({ env }) => env?.CLOUDFLARE_ACCOUNT_ID === account)).toBe(true);
	});

	it("writes and prints no data key, secrets-file value, password or plaintext secret", async () => {
		const dataKey = randomKey();
		const password = randomValue();
		const plaintexts = [randomValue(), randomValue()];
		const secrets = {
			CLOUDFLARE_ACCOUNT_ID: account,
			FIREBASE_API_KEY: randomValue(),
			PASSWORD_DISPATCHER_TENANT_A: password,
			DATA_KEY_V2_TENANT_A: dataKey,
		};
		project("takebase-staging-backups", secrets);
		const cf = fakeCloudflare({ "staging-tenant-a": await secretsKv(dataKey, plaintexts) });
		const out = io();
		expect(await backupCommand(["create", "--all", "--env", "staging"], out.io, cf.deps)).toBe(0);
		const everything = [...[...cf.r2.values()].map(String), out.text()].join("\n");
		expect(everything).toContain("A256GCM");
		for (const value of [
			...Object.values(secrets),
			...plaintexts,
			Buffer.from(dataKey, "base64").toString("base64url"),
		]) {
			expect(everything).not.toContain(value);
		}
		expect(everything).not.toContain("secrets.env");
	});

	it("refuses a bucket outside the environment's name prefix before any Cloudflare call", async () => {
		project("other-project-backups", { CLOUDFLARE_ACCOUNT_ID: account, FIREBASE_API_KEY: randomValue() });
		const cf = fakeCloudflare({});
		const out = io();
		await expect(backupCommand(["init", "--env", "staging"], out.io, cf.deps)).rejects.toThrow(
			'Refusing to touch R2 bucket "other-project-backups"',
		);
		expect(cf.calls).toEqual([]);
	});

	it("documents the consistency limits and the exclusions", () => {
		const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
		const section = readme.slice(readme.indexOf("### Backups"), readme.indexOf("### Dev, build and deploy"));
		expect(section).toContain("**not** one atomic snapshot");
		expect(section).toContain("Firebase Auth");
		expect(section).toContain("Realtime Database notifications");
		expect(section).toMatch(/escrow/);
		expect(section).toContain("Time Travel");
	});
});
