// Backups (SEGU-225): what one backup holds and how to prove it is intact. A
// backup is a set of objects under `backups/<backupId>/` plus a manifest,
// written last. Each part was captured at its own time: a backup is never one
// atomic snapshot across D1 databases, KV and configuration. The CLI writes
// them; the global Worker only reads them for a tenant's admins (SEGU-227).
//
// Integrity, not authenticity: the checksums detect corrupted, truncated,
// missing or edited objects, not someone with write access to the bucket who
// rewrites the objects, the manifest and the catalog consistently.

export type BackupScope = "tenant" | "global" | "all";

export type BackupObject = { key: string; bytes: number; sha256: string };

// A migration applied to the database, with the checksum of the repository file of that name.
export type BackupMigration = { name: string; sha256: string | null };

export type BackupPart =
	| {
			kind: "d1";
			// "global" or "tenant:<id>".
			target: string;
			database: string;
			capturedAt: string;
			// The last applied migration, or null for an empty history.
			schemaVersion: string | null;
			migrations: BackupMigration[];
			object: BackupObject;
	  }
	| {
			kind: "kv";
			target: string;
			binding: string;
			capturedAt: string;
			// Ciphertext envelopes only; the data key versions they need, never a key.
			count: number;
			keyVersions: number[];
			object: BackupObject;
	  }
	| { kind: "config"; target: string; capturedAt: string; object: BackupObject };

export type BackupManifest = {
	format: "takebase-backup";
	version: 1;
	backupId: string;
	created: string;
	environment: string;
	scope: BackupScope;
	cliVersion: string;
	parts: BackupPart[];
	// SHA-256 of the canonical JSON of every other field.
	manifestSha256: string;
};

export type BackupCatalogEntry = { backupId: string; created: string; scope: BackupScope; manifestSha256: string };

// A backup being pruned (SEGU-226): already out of `backups`, its objects
// still to delete. A rerun of prune finishes it.
export type BackupPruning = { backupId: string; keys: string[] };

// `backups/catalog.json`: Wrangler cannot list R2 objects, so the catalog is
// how backups are found. It never holds a verification result.
export type BackupCatalog = { version: 1; backups: BackupCatalogEntry[]; pruning?: BackupPruning[] };

// ---- what a tenant's admins see (SEGU-227) -----------------------------------

// One of this tenant's parts of a backup: what it is and its size, never its content.
export type TenantBackupPart = { kind: "d1" | "kv"; capturedAt: string; bytes: number };

// A backup that holds this tenant, described from its manifest alone: other
// tenants' parts and the global database are left out.
export type TenantBackup = {
	backupId: string;
	created: string;
	scope: BackupScope;
	environment: string;
	parts: TenantBackupPart[];
	// The tenant database's last migration, and the data key versions its secrets need.
	schemaVersion: string | null;
	migrations: string[];
	keyVersions: number[];
};

export type TenantBackupList = { backups: TenantBackup[] };

// The global Worker's check of one backup for this tenant: the manifest, and
// this tenant's objects by size and SHA-256, plus the secrets export's
// envelope count and key versions. It does not replay the SQL dump; that is
// `takebase backup verify`.
export type TenantBackupCheck = {
	backupId: string;
	status: "verified" | "failed";
	problems: string[];
	checked: string[];
};

// A read-only review of restoring one backup of this tenant. Nothing is created:
// the operator's CLI performs the restore, always into the new isolated target
// named here, never over the tenant's own database or secrets.
export type TenantRestorePlan = {
	backupId: string;
	tenantId: string;
	environment: string;
	restoreId: string;
	// Null when the backup's configuration cannot say where the restore would go.
	target: { database: string; namespace: string } | null;
	schemaVersion: string | null;
	migrations: string[];
	secrets: number;
	keyVersions: number[];
	check: TenantBackupCheck;
	// Everything that would block the restore, as far as the Workers can tell.
	// Empty does not replace the CLI's dry-run, which also replays the SQL export
	// and opens every secret with the operator's keys.
	problems: string[];
	commands: { dryRun: string; restore: string };
};
