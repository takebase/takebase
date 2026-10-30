import { loadProjectConfig, resolveEnvironment } from "../../packages/cli/src/project-config.ts";
import { r2Store } from "../../packages/cli/src/services/backup-export.ts";
import { backupPrefix, catalogKey, parseCatalog } from "../../packages/cli/src/services/backup-manifest.ts";
import { type CapturedPart, commitBackup, readText } from "../../packages/cli/src/services/backups.ts";
import { defaultRemoteDeps } from "../../packages/cli/src/services/remote-workers.ts";

// Disposable backups for the S-6-5-01 browser journey (SEGU-227), written by the
// CLI's own commit path into local R2. The content is fixture data whose markers
// must never reach the browser; the data is valid, so a leftover would still pass
// `takebase backup verify`. Only local R2: this file never takes an environment.

const root = new URL("../../", import.meta.url).pathname;
const project = loadProjectConfig(root);
const environment = resolveEnvironment(project, "local");
const store = r2Store(defaultRemoteDeps, project, environment);
const encoder = new TextEncoder();

const base64url = (length: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(length))).toString("base64url");

const dump = (migrations: string[], marker: string) =>
	encoder.encode(
		[
			"CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT);",
			...migrations.map((name, i) => `INSERT INTO d1_migrations VALUES(${i + 1}, '${name}');`),
			"CREATE TABLE fixture(value TEXT);",
			`INSERT INTO fixture VALUES('${marker}');`,
		].join("\n"),
	);

export type RecoveryFixture = { backupId: string; markers: string[] };

// One backup of both local tenants, needing data key `keyVersion` for tenant-a.
export const writeFixtureBackup = async (created: Date, migrations: string[], keyVersion: number) => {
	const capturedAt = created.toISOString();
	const markers = {
		tenantA: `tenant-a-row-${crypto.randomUUID()}`,
		tenantB: `tenant-b-row-${crypto.randomUUID()}`,
		nonce: base64url(12),
		ciphertext: base64url(48),
	};
	const envelope = JSON.stringify({ v: 1, alg: "A256GCM", kv: keyVersion, n: markers.nonce, c: markers.ciphertext });
	const d1 = (tenant: string, marker: string): CapturedPart => ({
		kind: "d1",
		target: `tenant:${tenant}`,
		database: `takebase-${tenant}`,
		capturedAt,
		schemaVersion: migrations.at(-1) ?? null,
		migrations: migrations.map((name) => ({ name, sha256: null })),
		file: `d1-${tenant}.sql`,
		bytes: dump(migrations, marker),
	});
	const manifest = await commitBackup(store, { created, environment: "local", scope: "all", cliVersion: "fixture" }, [
		d1("tenant-a", markers.tenantA),
		d1("tenant-b", markers.tenantB),
		{
			kind: "kv",
			target: "tenant:tenant-a",
			binding: "SECRETS",
			capturedAt,
			count: 1,
			keyVersions: [keyVersion],
			file: "kv-tenant-a.ndjson",
			bytes: encoder.encode(`${JSON.stringify({ name: "secret/app/smtp", value: envelope })}\n`),
		},
		{
			kind: "config",
			target: "environment",
			capturedAt,
			file: "config.json",
			bytes: encoder.encode(
				JSON.stringify({
					environment: {
						name: "local",
						remote: false,
						namePrefix: null,
						tenants: [{ id: "tenant-a" }, { id: "tenant-b" }],
					},
					workers: { tenants: { "tenant-a": { vars: { TENANT_ID: "tenant-a" } } } },
				}),
			),
		},
	]);
	return { backupId: manifest.backupId, markers: Object.values(markers), manifest };
};

// The catalog's bytes, to prove the browser journey changed nothing.
export const catalogText = () => readText(store, catalogKey);

// Removes the fixtures: out of the catalog first, then their objects.
export const removeFixtureBackups = async (fixtures: Awaited<ReturnType<typeof writeFixtureBackup>>[]) => {
	const catalog = parseCatalog(await catalogText());
	const ids = new Set(fixtures.map(({ backupId }) => backupId));
	catalog.backups = catalog.backups.filter(({ backupId }) => !ids.has(backupId));
	await store.put(catalogKey, encoder.encode(`${JSON.stringify(catalog, null, "\t")}\n`), "application/json");
	for (const { backupId, manifest } of fixtures) {
		for (const { object } of manifest.parts) await store.delete(object.key);
		await store.delete(`${backupPrefix(backupId)}manifest.json`);
	}
};
