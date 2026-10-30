import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupCommand } from "../../packages/cli/src/commands/backup.ts";
import { contentDigest, importSql } from "../../packages/cli/src/services/backups.ts";
import { account, backupProject, cliIo, fakeCloudflare, secretsKv } from "../fixtures/backup-cloudflare.ts";
import { randomKey, randomValue } from "../fixtures/secret-store.ts";

// R-6-4-01 (SEGU-226): `backup restore --dry-run` creates and changes
// nothing, and every invalid backup, schema, target or key state blocks the
// restore before any write. Remote project with a fake Wrangler
// (tests/fixtures/backup-cloudflare.ts); keys and values are random per run.

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "takebase-restore-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

// Wrangler calls that create, write or delete anything.
const writes = (calls: { args: string[] }[]) =>
	calls.filter(({ args }) =>
		["put", "create", "execute", "delete", "bulk"].some((verb) => args.slice(0, 3).includes(verb)),
	);

const writeSecrets = (values: Record<string, string>) =>
	writeFileSync(
		join(root, "secrets.env"),
		`${Object.entries(values)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n")}\n`,
	);

const backedUp = async () => {
	const dataKey = randomKey();
	const plaintexts = [randomValue(), randomValue()];
	const secrets = {
		CLOUDFLARE_ACCOUNT_ID: account,
		FIREBASE_API_KEY: randomValue(),
		PASSWORD_DISPATCHER_TENANT_A: randomValue(),
		DATA_KEY_V2_TENANT_A: dataKey,
	};
	backupProject(root, "takebase-staging-backups", secrets);
	// D1 databases and KV namespaces the fake account holds; a test may add some.
	const existing: string[] = [];
	const cf = fakeCloudflare({ "staging-tenant-a": await secretsKv(dataKey, plaintexts) }, existing);
	const created = cliIo(root);
	expect(await backupCommand(["create", "--all", "--env", "staging"], created.io, cf.deps)).toBe(0);
	const backupId = /Backup (\S+) of staging/.exec(created.text())?.[1] ?? "";
	// `takebase backup <args> --env staging`; a refusal counts as exit 1 with its message.
	const command = async (...args: string[]) => {
		const out = cliIo(root);
		const before = cf.calls.length;
		let code: number;
		try {
			code = await backupCommand([...args, "--env", "staging"], out.io, cf.deps);
		} catch (error) {
			out.io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
			code = 1;
		}
		return { code, text: out.text(), calls: cf.calls.slice(before) };
	};
	const restore = (...target: string[]) => command("restore", backupId, ...target, "--dry-run");
	return { cf, backupId, secrets, plaintexts, existing, command, restore };
};
type Backup = Awaited<ReturnType<typeof backedUp>>;

describe("takebase backup restore --dry-run (R-6-4-01)", () => {
	it("prints the isolated plan for a tenant and the global database, and creates or changes nothing", async () => {
		const { cf, backupId, secrets, plaintexts, restore } = await backedUp();
		const r2Before = new Map(cf.r2);
		const tenant = await restore("--tenant", "tenant-a");
		expect(tenant.code, tenant.text).toBe(0);
		expect(tenant.text).toContain(`into   takebase-staging-restore-${backupId.toLowerCase()}-tenant-a`);
		expect(tenant.text).toMatch(/table {2}policies +1 rows/);
		expect(tenant.text).toContain("2 ciphertext secrets, key versions v2");
		expect(tenant.text).toContain("Dry run: every check passed; nothing was created or changed.");
		const global = await restore("--global");
		expect(global.code, global.text).toBe(0);
		expect(global.text).toMatch(/table {2}tenants +1 rows/);
		for (const run of [tenant, global]) {
			expect(writes(run.calls)).toEqual([]);
			expect(run.calls.every(({ env }) => env?.CLOUDFLARE_ACCOUNT_ID === account)).toBe(true);
			for (const value of [...Object.values(secrets), ...plaintexts]) expect(run.text).not.toContain(value);
		}
		expect(cf.r2).toEqual(r2Before);
	});

	const blocked: { name: string; damage: (backup: Backup) => void; expected: string }[] = [
		{
			name: "a corrupted backup object",
			damage: ({ cf }) => {
				const key = [...cf.r2.keys()].find((name) => name.endsWith("tenants/tenant-a/d1.sql")) ?? "";
				cf.r2.set(key, Buffer.from(String(cf.r2.get(key)).replace("row-1", "row-2")));
			},
			expected: "checksum mismatch",
		},
		{
			name: "an unreadable manifest",
			damage: ({ cf }) => {
				const key = [...cf.r2.keys()].find((name) => name.endsWith("manifest.json")) ?? "";
				cf.r2.set(key, Buffer.from("{not json"));
			},
			expected: "manifest unreadable",
		},
		{
			name: "a migration edited since the backup",
			damage: () => writeFileSync(join(root, "migrations/tenant/0000_policies.sql"), "-- edited\n"),
			expected: "migration 0000_policies.sql differs from the repository's file",
		},
		{
			name: "a tenant whose identity changed in wrangler.jsonc",
			damage: () => {
				const path = join(root, "tenant/wrangler.jsonc");
				writeFileSync(path, readFileSync(path, "utf8").replace('"TENANT_ID":"tenant-a"', '"TENANT_ID":"tenant-b"'));
			},
			expected: "TENANT_ID of tenant tenant-a differs between the backup and wrangler.jsonc",
		},
		{
			name: "a missing data key version",
			damage: ({ secrets }) => {
				const { DATA_KEY_V2_TENANT_A: _gone, ...rest } = secrets;
				writeSecrets(rest);
			},
			expected: "data key v2 of tenant-a is in neither the keys file nor the escrow",
		},
		{
			name: "a data key that does not open the secrets",
			damage: ({ secrets }) => writeSecrets({ ...secrets, DATA_KEY_V2_TENANT_A: randomKey() }),
			expected: "data key v2 does not open 2 of the secrets stored under it",
		},
		{
			name: "a target that already exists",
			damage: ({ backupId, existing }) => existing.push(`takebase-staging-restore-${backupId.toLowerCase()}-tenant-a`),
			expected: "already exists",
		},
	];

	it.each(blocked)("blocks $name before any write", async ({ damage, expected }) => {
		const backup = await backedUp();
		damage(backup);
		const run = await backup.restore("--tenant", "tenant-a");
		expect(run.code).toBe(1);
		expect(run.text).toContain("Restore BLOCKED:");
		expect(run.text).toContain(expected);
		expect(writes(run.calls)).toEqual([]);
	});

	it("blocks a tenant the backup does not hold", async () => {
		const { restore } = await backedUp();
		const run = await restore("--tenant", "tenant-c");
		expect(run.code).toBe(1);
		expect(run.text).toContain("holds no D1 export for tenant:tenant-c");
		expect(writes(run.calls)).toEqual([]);
	});
});

// The progress record of a restore, as the CLI keeps it (untracked, under ops/).
const progressOf = (restoreId: string) =>
	JSON.parse(readFileSync(join(root, "ops", ".restores", `staging-${restoreId}.json`), "utf8")) as {
		step: string;
		proof: unknown;
	};

// Calls that could write to a source: D1 work outside the restore's own
// configuration, or KV writes through a Worker binding.
const sourceWrites = (calls: { args: string[] }[]) =>
	calls.filter(
		({ args }) =>
			(args[0] === "d1" &&
				["execute", "delete"].includes(args[1] ?? "") &&
				!args.includes("-c") &&
				args[1] !== "delete") ||
			(args[0] === "d1" && args[1] === "delete" && !String(args[2]).startsWith("takebase-staging-restore-")) ||
			(args[0] === "kv" && ["put", "delete"].some((verb) => args.includes(verb)) && args.includes("--binding")) ||
			(args[0] === "r2" && args[2] !== "get"),
	);

describe("takebase backup restore --confirm (R-6-4-01, S-6-4-01)", () => {
	it("restores a tenant and the global database into new isolated targets and proves them", async () => {
		const { cf, backupId, secrets, plaintexts, command } = await backedUp();
		const r2Before = new Map(cf.r2);
		const tenant = await command("restore", backupId, "--tenant", "tenant-a", "--confirm", "staging");
		expect(tenant.code, tenant.text).toBe(0);
		const tenantName = `takebase-staging-restore-${backupId.toLowerCase()}-tenant-a`;
		expect(tenant.text).toContain(`proved in ${tenantName}`);
		expect(tenant.text).toContain("2 of 2 secrets opened");
		expect(cf.databases.get(tenantName)?.sql).toContain('INSERT INTO "policies"');
		expect([...cf.namespaces.values()].find(({ title }) => title === tenantName)?.entries.size).toBe(2);
		const global = await command("restore", backupId, "--global", "--confirm", "staging");
		expect(global.code, global.text).toBe(0);
		expect(global.text).toContain(`proved in takebase-staging-restore-${backupId.toLowerCase()}-global`);
		// Nothing but the new targets was created; no source was written; no secret was printed or recorded.
		const created = [...tenant.calls, ...global.calls].filter(({ args }) => args.includes("create"));
		expect(created.every(({ args }) => args.some((arg) => arg.startsWith("takebase-staging-restore-")))).toBe(true);
		expect(created.every(({ args }) => args.includes("--update-config=false"))).toBe(true);
		expect(sourceWrites([...tenant.calls, ...global.calls])).toEqual([]);
		expect(cf.r2).toEqual(r2Before);
		const record = readFileSync(
			join(root, "ops", ".restores", `staging-${backupId.toLowerCase()}-tenant-a.json`),
			"utf8",
		);
		for (const value of [...Object.values(secrets), ...plaintexts]) {
			expect(tenant.text + global.text + record).not.toContain(value);
		}
		// A rerun of a proved restore changes nothing.
		const again = await command("restore", backupId, "--tenant", "tenant-a", "--confirm", "staging");
		expect(again.text).toContain("already done and proved");
		expect(writes(again.calls)).toEqual([]);
	});

	it("needs --confirm naming the environment before any call", async () => {
		const { backupId, command } = await backedUp();
		const wrong = await command("restore", backupId, "--tenant", "tenant-a", "--confirm", "local");
		expect(wrong.code).not.toBe(0);
		expect(wrong.text).toContain('--confirm local does not name environment "staging"');
		expect(wrong.calls).toEqual([]);
		const neither = await command("restore", backupId, "--tenant", "tenant-a");
		expect(neither.text).toContain("exactly one of --dry-run or --confirm <env>");
		expect(neither.calls).toEqual([]);
	});

	it("continues an interrupted restore without importing the database twice", async () => {
		const { cf, backupId, command } = await backedUp();
		const restoreId = `${backupId.toLowerCase()}-tenant-a`;
		cf.faults.bulk = 1;
		const first = await command("restore", backupId, "--tenant", "tenant-a", "--confirm", "staging");
		expect(first.code).toBe(1);
		expect(first.text).toContain("kv bulk put");
		expect(progressOf(restoreId).step).toBe("imported-d1");
		const second = await command("restore", backupId, "--tenant", "tenant-a", "--confirm", "staging");
		expect(second.code, second.text).toBe(0);
		expect(second.text).toContain("continuing restore");
		const imports = [...first.calls, ...second.calls].filter(
			({ args }) => args.includes("--file") && args[1] === "execute",
		);
		expect(imports).toHaveLength(1);
		expect(progressOf(restoreId).step).toBe("proved");
	});

	it("reports a half-imported target instead of importing again, and --discard removes only it", async () => {
		const { cf, backupId, command, existing } = await backedUp();
		const restoreId = `${backupId.toLowerCase()}-tenant-a`;
		const name = `takebase-staging-restore-${restoreId}`;
		cf.faults.import = "partial";
		expect((await command("restore", backupId, "--tenant", "tenant-a", "--confirm", "staging")).code).toBe(1);
		const rerun = await command("restore", backupId, "--tenant", "tenant-a", "--confirm", "staging");
		expect(rerun.code).toBe(1);
		expect(rerun.text).toContain("already holds tables: an earlier import was interrupted");
		expect(rerun.calls.filter(({ args }) => args[1] === "execute" && args.includes("--file"))).toEqual([]);
		const discarded = await command("restore", "--discard", restoreId, "--confirm", "staging");
		expect(discarded.code, discarded.text).toBe(0);
		expect(cf.databases.has(name)).toBe(false);
		expect([...cf.namespaces.values()].some(({ title }) => title === name)).toBe(false);
		expect(sourceWrites(discarded.calls)).toEqual([]);
		// A record edited to point at a source is refused.
		const path = join(root, "ops", ".restores", `staging-${restoreId}.json`);
		const first = await command("restore", backupId, "--tenant", "tenant-a", "--confirm", "staging");
		expect(first.code, first.text).toBe(0);
		const proved = readFileSync(path, "utf8");
		writeFileSync(path, proved.replaceAll(name, "takebase-staging-tenant-a"));
		const refused = await command("restore", "--discard", restoreId, "--confirm", "staging");
		expect(refused.text).toContain("not a restore target");
		// ... and so is a record whose namespace id is another namespace's.
		existing.push("takebase-staging-tenant-a-secrets");
		writeFileSync(
			path,
			proved.replace(/"namespaceId": "[^"]*"/, '"namespaceId": "id-takebase-staging-tenant-a-secrets"'),
		);
		const wrongId = await command("restore", "--discard", restoreId, "--confirm", "staging");
		expect(wrongId.text).toContain('it is "takebase-staging-tenant-a-secrets"');
		expect([...refused.calls, ...wrongId.calls].filter(({ args }) => args.includes("delete"))).toEqual([]);
	});

	it("does not call a restore proved when a value differs, even with equal row counts", async () => {
		const { cf, backupId, command } = await backedUp();
		cf.faults.export = (sql) => sql.replace("'row-1'", "'row-X'");
		const run = await command("restore", backupId, "--tenant", "tenant-a", "--confirm", "staging");
		expect(run.code).toBe(1);
		expect(run.text).toContain("is NOT proved");
		expect(run.text).toContain("table policies: 1 rows differ");
		expect(progressOf(`${backupId.toLowerCase()}-tenant-a`).step).toBe("imported-kv");
	});
});

describe("the import order of a restored database", () => {
	it("loads a child-before-parent export where foreign keys are enforced, and fires no trigger", () => {
		// The shape of Wrangler's global export: memberships (child) is created and
		// filled before tenants (parent); the trigger comes last.
		const exported = [
			"PRAGMA defer_foreign_keys=TRUE;",
			"CREATE TABLE `memberships` (`id` text PRIMARY KEY NOT NULL, `tenant_id` text NOT NULL, FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`));",
			'INSERT INTO "memberships" ("id","tenant_id") VALUES(\'m1\',\'t1\');',
			"CREATE TABLE `tenants` (`id` text PRIMARY KEY NOT NULL, `name` text, `access_revision` integer DEFAULT 0 NOT NULL, `logo` blob);",
			'INSERT INTO "tenants" ("id","name","access_revision","logo") VALUES(\'t1\',\'O\'\'Brien; Ltd\',7,X\'00ff\');',
			// `_` is a LIKE wildcard: a name like this must not be taken for a `_cf_` table.
			"CREATE TABLE `xcf_notes` (`id` text PRIMARY KEY NOT NULL);",
			'INSERT INTO "xcf_notes" ("id") VALUES(\'n1\');',
			"CREATE TRIGGER `bump` AFTER INSERT ON `memberships` BEGIN UPDATE `tenants` SET `access_revision` = `access_revision` + 1 WHERE `id` = NEW.`tenant_id`; END;",
		].join("\n");
		const enforcing = () => new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
		const raw = enforcing();
		expect(() => raw.exec(exported)).toThrow(/no such table/);
		raw.close();
		const db = enforcing();
		db.exec(importSql(exported));
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(db.prepare("SELECT access_revision FROM tenants").get()?.access_revision).toBe(7);
		expect(db.prepare("SELECT id FROM xcf_notes").get()?.id).toBe("n1");
		db.close();
		expect(contentDigest(importSql(exported))).toEqual(contentDigest(exported));
	});
});
