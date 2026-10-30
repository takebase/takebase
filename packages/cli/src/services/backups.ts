import { constants, DatabaseSync } from "node:sqlite";
import { CliError } from "../errors.ts";
import {
	type BackupCatalogEntry,
	type BackupManifest,
	type BackupPart,
	type BackupScope,
	backupIdOf,
	backupPrefix,
	canonicalJson,
	catalogKey,
	describeObject,
	manifestChecksum,
	manifestKey,
	parseCatalog,
	parseManifest,
	sealManifest,
	sha256,
} from "./backup-manifest.ts";
import { parseEnvelope } from "./secret-envelopes.ts";

// Writing, verifying and listing backups (SEGU-225) over any object store: R2
// through Wrangler in the CLI, memory in tests. Objects go first, the manifest
// after them and the catalog entry last, so an interrupted backup is never
// listed. Verification is recomputed every time and never stored, so a backup
// cannot keep a "verified" it no longer deserves.

export type BackupStore = {
	get: (key: string) => Promise<Uint8Array | null>;
	put: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;
	// Removes an object; a missing one is not an error.
	delete: (key: string) => Promise<void>;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// One captured part: its manifest fields, plus the bytes stored at `file` under the backup.
export type CapturedPart = DistributiveOmit<BackupPart, "object"> & { file: string; bytes: Uint8Array };

export type BackupDraft = {
	created: Date;
	environment: string;
	scope: BackupScope;
	tenantId?: string;
	cliVersion: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const contentTypes: Record<BackupPart["kind"], string> = {
	d1: "application/sql",
	kv: "application/x-ndjson",
	config: "application/json",
};

export const commitBackup = async (store: BackupStore, draft: BackupDraft, captured: CapturedPart[]) => {
	const backupId = backupIdOf(draft.created, draft.scope, draft.tenantId);
	// Before any write: a second backup in the same second must not overwrite a catalogued one.
	const taken = (catalog: { backups: BackupCatalogEntry[] }) =>
		catalog.backups.some((entry) => entry.backupId === backupId);
	const duplicate = () =>
		new CliError(`Backup ${backupId} is already in the catalog`, { hint: "Wait a second and run it again." });
	if (taken(parseCatalog(await readText(store, catalogKey)))) throw duplicate();
	const parts: BackupPart[] = [];
	for (const { file, bytes, ...part } of captured) {
		const object = describeObject(`${backupPrefix(backupId)}${file}`, bytes);
		await store.put(object.key, bytes, contentTypes[part.kind]);
		parts.push({ ...part, object } as BackupPart);
	}
	const manifest = sealManifest({
		format: "takebase-backup",
		version: 1,
		backupId,
		created: draft.created.toISOString(),
		environment: draft.environment,
		scope: draft.scope,
		cliVersion: draft.cliVersion,
		parts,
	});
	await store.put(
		manifestKey(backupId),
		encoder.encode(`${JSON.stringify(manifest, null, "\t")}\n`),
		"application/json",
	);
	const catalog = parseCatalog(await readText(store, catalogKey));
	if (taken(catalog)) throw duplicate();
	catalog.backups.push({
		backupId,
		created: manifest.created,
		scope: manifest.scope,
		manifestSha256: manifest.manifestSha256,
	});
	await store.put(catalogKey, encoder.encode(`${JSON.stringify(catalog, null, "\t")}\n`), "application/json");
	return manifest;
};

export const readText = async (store: BackupStore, key: string) => {
	const bytes = await store.get(key);
	return bytes === null ? null : decoder.decode(bytes);
};

export type BackupVerification = {
	backupId: string;
	status: "verified" | "failed";
	problems: string[];
	manifest: BackupManifest | null;
};

// Replays a D1 export into an empty in-memory SQLite database, then inspects
// it. Foreign keys are checked after the load, not during it: Wrangler exports
// tables in creation order, which can put a child table before a parent that a
// later migration recreated.
// The SQL is untrusted on verify, so while it runs it may not attach other
// databases (files) or run any pragma but the foreign key ones exports use.
const replayPragmas = new Set(["defer_foreign_keys", "foreign_keys"]);
const replay = <T>(sql: string, inspect: (db: DatabaseSync) => T) => {
	const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
	try {
		db.setAuthorizer((action, name) => {
			if (action === constants.SQLITE_ATTACH || action === constants.SQLITE_DETACH) return constants.SQLITE_DENY;
			if (action === constants.SQLITE_PRAGMA && !replayPragmas.has(String(name).toLowerCase())) {
				return constants.SQLITE_DENY;
			}
			return constants.SQLITE_OK;
		});
		db.exec(sql);
		db.setAuthorizer(null);
		const integrity = db.prepare("PRAGMA integrity_check").all();
		if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("integrity_check failed");
		if (db.prepare("PRAGMA foreign_key_check").all().length > 0) throw new Error("foreign_key_check found violations");
		return inspect(db);
	} finally {
		db.close();
	}
};

const migrationNames = (db: DatabaseSync) => {
	const history = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'").all();
	if (history.length === 0) return [];
	return db
		.prepare("SELECT name FROM d1_migrations ORDER BY id")
		.all()
		.map((row) => String(row.name));
};

export const replayD1 = (sql: string) => replay(sql, migrationNames);

// What a D1 export holds, as digests to compare two exports: every table,
// index and trigger definition, and each table's rows in any order.
export const contentDigest = (sql: string) =>
	replay(sql, (db) => {
		const schema = db
			.prepare(
				"SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name",
			)
			.all();
		const tables: Record<string, { rows: number; sha256: string }> = {};
		for (const { type, name } of schema) {
			if (type !== "table") continue;
			const rows = db
				.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`)
				.all()
				.map((row) => canonicalJson(row))
				.sort();
			tables[String(name)] = { rows: rows.length, sha256: sha256(rows.join("\n")) };
		}
		return { schema: sha256(canonicalJson(schema)), tables };
	});

// A D1 export rewritten for import into an empty database (SEGU-226). D1
// always enforces foreign keys, and deferring them does not help a row whose
// parent table does not exist yet: Wrangler's export of the global database
// fills `memberships` before it creates `tenants`. So the verified replay is
// written out again in a safe order: every table, then the rows with parents
// before children (SQLite's own quote() writes each value), then indexes,
// then triggers, so no trigger fires during the import.
export const importSql = (sql: string) =>
	replay(sql, (db) => {
		const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
		const schema = db
			.prepare(
				"SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid",
			)
			.all()
			.map((row) => ({ type: String(row.type), name: String(row.name), sql: String(row.sql) }));
		const tables = schema.filter(({ type }) => type === "table").map(({ name }) => name);
		const parents = new Map(
			tables.map((table) => [
				table,
				db
					.prepare(`PRAGMA foreign_key_list(${ident(table)})`)
					.all()
					.map((row) => String(row.table))
					.filter((parent) => parent !== table && tables.includes(parent)),
			]),
		);
		const ordered: string[] = [];
		const visit = (table: string, path: string[]) => {
			if (ordered.includes(table) || path.includes(table)) return;
			for (const parent of parents.get(table) ?? []) visit(parent, [...path, table]);
			ordered.push(table);
		};
		for (const table of tables) visit(table, []);
		const lines = ["PRAGMA defer_foreign_keys=TRUE;"];
		for (const { type, sql: definition } of schema) if (type === "table") lines.push(`${definition};`);
		for (const table of ordered) {
			const columns = db
				.prepare(`PRAGMA table_info(${ident(table)})`)
				.all()
				.map((row) => String(row.name));
			if (columns.length === 0) continue;
			const values = columns.map((column) => `quote(${ident(column)})`).join(" || ',' || ");
			const rows = db.prepare(`SELECT ${values} AS row FROM ${ident(table)}`).all();
			for (const { row } of rows) {
				lines.push(`INSERT INTO ${ident(table)} (${columns.map(ident).join(",")}) VALUES(${String(row)});`);
			}
		}
		const sequence = db.prepare("SELECT name FROM sqlite_schema WHERE name = 'sqlite_sequence'").all();
		if (sequence.length > 0) {
			for (const { name, seq } of db.prepare("SELECT name, seq FROM sqlite_sequence").all()) {
				lines.push(
					`INSERT INTO sqlite_sequence (name, seq) VALUES(${db.prepare("SELECT quote(?) AS v").get(String(name))?.v}, ${Number(seq)});`,
				);
			}
		}
		for (const type of ["index", "trigger", "view"]) {
			for (const entry of schema) if (entry.type === type) lines.push(`${entry.sql};`);
		}
		return `${lines.join("\n")}\n`;
	});

// Each table of a D1 export with its row count, after the same isolated replay.
export const tableCounts = (sql: string) =>
	replay(sql, (db) =>
		db
			.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
			.all()
			.map((row) => {
				const name = String(row.name);
				const count = db.prepare(`SELECT count(*) AS rows FROM "${name.replaceAll('"', '""')}"`).get();
				return { name, rows: Number(count?.rows ?? 0) };
			}),
	);

// The key versions in a KV export, after checking every line is a ciphertext envelope.
const readKv = (text: string) => {
	const lines = text.split("\n").filter((line) => line !== "");
	const versions = new Set<number>();
	for (const line of lines) {
		const entry = JSON.parse(line) as { name?: unknown; value?: unknown };
		if (typeof entry.name !== "string" || !entry.name.startsWith("secret/") || typeof entry.value !== "string") {
			throw new Error("an entry is not a secret/ key with a string value");
		}
		versions.add(parseEnvelope(entry.value).keyVersion);
	}
	return { count: lines.length, keyVersions: [...versions].sort((a, b) => a - b) };
};

const sameList = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((item, i) => item === b[i]);

// What the content of an intact object says, against its manifest part.
const checkContent = (part: BackupPart, bytes: Uint8Array): string | null => {
	try {
		const text = decoder.decode(bytes);
		if (part.kind === "d1") {
			const applied = replayD1(text);
			const recorded = part.migrations.map((migration) => migration.name);
			if (!sameList(applied, recorded)) return "migration history differs from the manifest";
			if (part.schemaVersion !== (recorded.at(-1) ?? null)) return "schema version differs from the migration list";
			return null;
		}
		if (part.kind === "kv") {
			const { count, keyVersions } = readKv(text);
			if (count !== part.count) return `holds ${count} secrets, the manifest says ${part.count}`;
			if (!sameList(keyVersions, part.keyVersions)) return "key versions differ from the manifest";
			return null;
		}
		JSON.parse(text);
		return null;
	} catch (error) {
		return `unreadable (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
	}
};

const verifyAgainst = async (
	store: BackupStore,
	backupId: string,
	entry: BackupCatalogEntry | undefined,
): Promise<BackupVerification> => {
	const problems: string[] = [];
	const failed = (manifest: BackupManifest | null = null): BackupVerification => ({
		backupId,
		status: "failed",
		problems,
		manifest,
	});
	if (entry === undefined) problems.push("not in the catalog (incomplete or foreign backup)");
	const raw = await store.get(manifestKey(backupId));
	let text: string | null | undefined = null;
	try {
		text = raw === null ? null : decoder.decode(raw);
	} catch {
		text = undefined;
	}
	if (text === null) problems.push("manifest missing");
	const manifest = typeof text === "string" ? parseManifest(text) : null;
	if (text !== null && manifest === null) problems.push("manifest unreadable");
	if (manifest === null) return failed();
	if (manifest.backupId !== backupId) problems.push(`manifest names backup ${manifest.backupId}`);
	if (manifestChecksum(manifest) !== manifest.manifestSha256) problems.push("manifest checksum mismatch");
	if (entry !== undefined && entry.manifestSha256 !== manifest.manifestSha256) {
		problems.push("manifest differs from the catalog entry");
	}
	if (manifest.parts.length === 0) problems.push("manifest lists no parts");
	for (const part of manifest.parts) {
		const { key, bytes: expected } = part.object;
		if (!key.startsWith(backupPrefix(backupId))) {
			problems.push(`${key}: outside the backup`);
			continue;
		}
		const bytes = await store.get(key);
		if (bytes === null) {
			problems.push(`${key}: missing`);
			continue;
		}
		if (bytes.byteLength !== expected) {
			problems.push(`${key}: ${bytes.byteLength} bytes, expected ${expected} (truncated or altered)`);
			continue;
		}
		if (sha256(bytes) !== part.object.sha256) {
			problems.push(`${key}: checksum mismatch`);
			continue;
		}
		const content = checkContent(part, bytes);
		if (content !== null) problems.push(`${key}: ${content}`);
	}
	return problems.length === 0 ? { backupId, status: "verified", problems, manifest } : failed(manifest);
};

export const verifyBackup = async (store: BackupStore, backupId: string) => {
	const catalog = parseCatalog(await readText(store, catalogKey));
	return verifyAgainst(
		store,
		backupId,
		catalog.backups.find((entry) => entry.backupId === backupId),
	);
};

export const newestFirst = (a: BackupCatalogEntry, b: BackupCatalogEntry) =>
	a.created < b.created ? 1 : a.created > b.created ? -1 : 0;

export const latestBackupId = async (store: BackupStore) =>
	[...parseCatalog(await readText(store, catalogKey)).backups].sort(newestFirst)[0]?.backupId;

// Every catalogued backup, newest first, each verified again now.
export const listBackups = async (store: BackupStore) => {
	const catalog = parseCatalog(await readText(store, catalogKey));
	const entries = [...catalog.backups].sort(newestFirst);
	const listed: { entry: BackupCatalogEntry; verification: BackupVerification }[] = [];
	for (const entry of entries) listed.push({ entry, verification: await verifyAgainst(store, entry.backupId, entry) });
	return listed;
};
