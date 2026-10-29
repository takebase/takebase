import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	catalogKey,
	manifestChecksum,
	manifestKey,
	parseManifest,
} from "../../packages/cli/src/services/backup-manifest.ts";
import { type CapturedPart, commitBackup, listBackups, verifyBackup } from "../../packages/cli/src/services/backups.ts";
import { importDataKey, sealEnvelope } from "../../packages/cli/src/services/secret-envelopes.ts";
import { memoryStore } from "../fixtures/backup-store.ts";
import { randomKey, randomValue } from "../fixtures/secret-store.ts";

// R-6-3-01: a backup is listed as verified only while every object, the
// manifest and the catalog agree. Each damage below must fail verification and
// never show as verified in list. The store is memory; the real R2 path is the
// create test and the smoke journey.

const encode = (text: string) => new TextEncoder().encode(text);
const migrations = ["0000_policies.sql", "0001_outbox.sql"];
const exportSql = (applied: string[]) =>
	[
		"PRAGMA defer_foreign_keys=TRUE;",
		'CREATE TABLE IF NOT EXISTS "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);',
		...applied.map((name, i) => `INSERT INTO "d1_migrations" ("id","name") VALUES(${i + 1},'${name}');`),
		"CREATE TABLE `policies` (`id` text PRIMARY KEY NOT NULL, `number` text NOT NULL);",
		'INSERT INTO "policies" ("id","number") VALUES(\'p1\',\'POL-1\');',
	].join("\n");

const capture = async (applied = migrations): Promise<CapturedPart[]> => {
	const key = await importDataKey(randomKey());
	const binding = { tenantId: "tenant-a", environment: "local", keyVersion: 2, purpose: "smtp", name: "password" };
	const envelope = await sealEnvelope(key, binding, encode(randomValue()));
	const at = "2026-10-28T12:00:00.000Z";
	return [
		{
			kind: "d1",
			target: "tenant:tenant-a",
			database: "takebase-tenant-a",
			capturedAt: at,
			schemaVersion: migrations.at(-1) ?? null,
			migrations: migrations.map((name) => ({ name, sha256: null })),
			file: "tenants/tenant-a/d1.sql",
			bytes: encode(exportSql(applied)),
		},
		{
			kind: "kv",
			target: "tenant:tenant-a",
			binding: "SECRETS",
			capturedAt: at,
			count: 1,
			keyVersions: [2],
			file: "tenants/tenant-a/kv-secrets.jsonl",
			bytes: encode(`${JSON.stringify({ name: "secret/smtp/password", value: envelope, metadata: { kv: 2 } })}\n`),
		},
		{
			kind: "config",
			target: "environment",
			capturedAt: at,
			file: "config.json",
			bytes: encode('{"environment":"local"}\n'),
		},
	];
};

const draft = {
	created: new Date("2026-10-28T12:00:00Z"),
	environment: "local",
	scope: "tenant",
	tenantId: "tenant-a",
	cliVersion: "0.0.0",
} as const;

const backed = async (applied?: string[]) => {
	const { objects, store } = memoryStore();
	const manifest = await commitBackup(store, draft, await capture(applied));
	const key = (file: string) => `backups/${manifest.backupId}/${file}`;
	return { objects, store, manifest, key };
};

type Backed = Awaited<ReturnType<typeof backed>>;

const rewriteManifest = (b: Backed, change: (manifest: Record<string, unknown>) => void) => {
	const manifest = JSON.parse(new TextDecoder().decode(b.objects.get(manifestKey(b.manifest.backupId)))) as Record<
		string,
		unknown
	>;
	change(manifest);
	b.objects.set(manifestKey(b.manifest.backupId), encode(JSON.stringify(manifest)));
};

describe("backup verification (R-6-3-01)", () => {
	it("verifies and lists an intact backup with its schema version, migrations, ciphertext count and config", async () => {
		const b = await backed();
		const verification = await verifyBackup(b.store, b.manifest.backupId);
		expect(verification).toMatchObject({ status: "verified", problems: [] });
		expect(b.manifest.backupId).toBe("20261028T120000Z-tenant-tenant-a");
		expect(b.manifest.parts.map((part) => part.kind)).toEqual(["d1", "kv", "config"]);
		expect(b.manifest.parts[0]).toMatchObject({ schemaVersion: "0001_outbox.sql" });
		expect(b.manifest.parts[1]).toMatchObject({ count: 1, keyVersions: [2] });
		expect(manifestChecksum(b.manifest)).toBe(b.manifest.manifestSha256);
		const listed = await listBackups(b.store);
		expect(listed.map(({ verification }) => [verification.backupId, verification.status])).toEqual([
			[b.manifest.backupId, "verified"],
		]);
	});

	const damages: [string, (b: Backed) => void | Promise<void>, RegExp][] = [
		[
			"a corrupted object",
			(b) => {
				const bytes = b.objects.get(b.key("tenants/tenant-a/d1.sql")) as Uint8Array;
				bytes[bytes.length - 3] = (bytes[bytes.length - 3] as number) ^ 1;
			},
			/d1\.sql: checksum mismatch/,
		],
		[
			"a truncated object",
			(b) => {
				const key = b.key("tenants/tenant-a/kv-secrets.jsonl");
				b.objects.set(key, (b.objects.get(key) as Uint8Array).slice(0, 20));
			},
			/kv-secrets\.jsonl: 20 bytes, expected \d+ \(truncated or altered\)/,
		],
		["a missing object", (b) => void b.objects.delete(b.key("config.json")), /config\.json: missing/],
		[
			"a tampered manifest",
			(b) =>
				rewriteManifest(b, (manifest) => {
					(manifest.parts as { count?: number }[])[1] = { ...(manifest.parts as object[])[1], count: 0 };
				}),
			/manifest checksum mismatch/,
		],
		[
			"a tampered manifest with a recomputed checksum",
			(b) =>
				rewriteManifest(b, (manifest) => {
					manifest.environment = "staging";
					manifest.manifestSha256 = manifestChecksum(manifest as never);
				}),
			/manifest differs from the catalog entry/,
		],
		["a deleted manifest", (b) => void b.objects.delete(manifestKey(b.manifest.backupId)), /manifest missing/],
		[
			"an unreadable manifest",
			(b) => void b.objects.set(manifestKey(b.manifest.backupId), encode("{not json")),
			/manifest unreadable/,
		],
	];

	it.each(damages)("fails verification and is never listed as verified after %s", async (_name, damage, problem) => {
		const b = await backed();
		await damage(b);
		const verification = await verifyBackup(b.store, b.manifest.backupId);
		expect(verification.status).toBe("failed");
		expect(verification.problems.join("\n")).toMatch(problem);
		const listed = await listBackups(b.store);
		expect(listed.map(({ verification }) => verification.status)).toEqual(["failed"]);
	});

	it("fails an export whose migration history differs from its manifest", async () => {
		const b = await backed(["0000_policies.sql"]);
		const verification = await verifyBackup(b.store, b.manifest.backupId);
		expect(verification.problems).toEqual([
			`backups/${b.manifest.backupId}/tenants/tenant-a/d1.sql: migration history differs from the manifest`,
		]);
	});

	it("never verifies or lists a backup that did not reach the catalog", async () => {
		const b = await backed();
		b.objects.delete(catalogKey);
		expect(await listBackups(b.store)).toEqual([]);
		const verification = await verifyBackup(b.store, b.manifest.backupId);
		expect(verification.status).toBe("failed");
		expect(verification.problems).toContain("not in the catalog (incomplete or foreign backup)");
		expect(parseManifest(new TextDecoder().decode(b.objects.get(manifestKey(b.manifest.backupId))))).not.toBeNull();
	});
	it("refuses a second backup in the same second without touching the first", async () => {
		const b = await backed();
		const before = new Map(b.objects);
		await expect(commitBackup(b.store, draft, await capture())).rejects.toThrow("is already in the catalog");
		expect(b.objects).toEqual(before);
		expect((await verifyBackup(b.store, b.manifest.backupId)).status).toBe("verified");
	});

	it("never lets an export attach a file while it is verified", async () => {
		const dir = mkdtempSync(join(tmpdir(), "takebase-attach-"));
		const target = join(dir, "written.db");
		try {
			const parts = await capture();
			const [d1] = parts;
			const sql = `ATTACH DATABASE '${target}' AS x;\nCREATE TABLE x.t (a);\n${exportSql(migrations)}`;
			parts[0] = { ...(d1 as CapturedPart), bytes: encode(sql) };
			const { store } = memoryStore();
			const manifest = await commitBackup(store, draft, parts);
			const verification = await verifyBackup(store, manifest.backupId);
			expect(verification.status).toBe("failed");
			expect(verification.problems.join("\n")).toMatch(/d1\.sql: unreadable \(not authorized\)/);
			expect(existsSync(target)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
