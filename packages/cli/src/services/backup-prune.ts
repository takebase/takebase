import { CliError } from "../errors.ts";
import { type BackupCatalogEntry, catalogKey, manifestKey, parseCatalog, parseManifest } from "./backup-manifest.ts";
import { type BackupStore, type BackupVerification, listBackups, readText } from "./backups.ts";

// `takebase backup prune` (SEGU-226): retention with protections. Backups are
// grouped by subject (`all`, `global`, `tenant-<id>`); in each subject the
// newest `keep` verified backups stay, and so does the newest verified one
// whatever `keep` says, and any backup a recorded restore still refers to.
// FAILED backups never count as kept copies; they are pruned like the rest.
//
// Order: the catalog first (the entry moves to its `pruning` list), then the
// objects, then the manifest, then the `pruning` entry goes. A crash leaves
// at worst objects no listed backup claims, which the next prune finishes;
// never a catalog entry claiming a backup whose objects are gone.

export type PruneDecision = {
	entry: BackupCatalogEntry;
	verification: BackupVerification;
	action: "keep" | "delete";
	reason: string;
};

const encoder = new TextEncoder();

// `all`, `global` or `tenant-<id>`: the backup id after its timestamp.
export const subjectOf = (backupId: string) => backupId.slice(backupId.indexOf("-") + 1);

export const planPrune = async (
	store: BackupStore,
	keep: number,
	// Backup ids a recorded restore refers to.
	inUse: ReadonlySet<string>,
): Promise<PruneDecision[]> => {
	if (!Number.isSafeInteger(keep) || keep < 1) {
		throw new CliError("--keep must be a whole number of at least 1", { usage: true });
	}
	const listed = await listBackups(store);
	const kept = new Map<string, number>();
	return listed.map(({ entry, verification }) => {
		const subject = subjectOf(entry.backupId);
		const decide = (action: PruneDecision["action"], reason: string) => ({ entry, verification, action, reason });
		if (inUse.has(entry.backupId)) return decide("keep", "a recorded restore refers to it");
		if (verification.status !== "verified") return decide("delete", "FAILED verification");
		const rank = (kept.get(subject) ?? 0) + 1;
		kept.set(subject, rank);
		if (rank === 1) return decide("keep", `newest verified ${subject} backup`);
		if (rank <= keep) return decide("keep", `verified ${subject} backup ${rank} of ${keep} kept`);
		return decide("delete", `older than the ${keep} newest verified ${subject} backups`);
	});
};

const writeCatalog = async (store: BackupStore, catalog: ReturnType<typeof parseCatalog>) => {
	const { pruning, ...rest } = catalog;
	const value = pruning === undefined || pruning.length === 0 ? rest : { ...rest, pruning };
	await store.put(catalogKey, encoder.encode(`${JSON.stringify(value, null, "\t")}\n`), "application/json");
};

// The objects of a backup, from its manifest when it is readable; the manifest last.
const objectsOf = async (store: BackupStore, backupId: string) => {
	const bytes = await store.get(manifestKey(backupId));
	let manifest = null;
	try {
		manifest = bytes === null ? null : parseManifest(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {}
	const prefix = `backups/${backupId}/`;
	const parts = (manifest?.parts ?? []).map((part) => part.object.key).filter((key) => key.startsWith(prefix));
	return [...new Set(parts), manifestKey(backupId)];
};

// Deletes what the plan says, catalog first; finishes earlier interrupted prunes too.
export const executePrune = async (store: BackupStore, decisions: PruneDecision[], report: (line: string) => void) => {
	const doomed = new Set(decisions.filter(({ action }) => action === "delete").map(({ entry }) => entry.backupId));
	const catalog = parseCatalog(await readText(store, catalogKey));
	const pruning = [...(catalog.pruning ?? [])];
	for (const backupId of doomed) {
		if (!catalog.backups.some((entry) => entry.backupId === backupId)) continue;
		pruning.push({ backupId, keys: await objectsOf(store, backupId) });
	}
	catalog.backups = catalog.backups.filter((entry) => !doomed.has(entry.backupId));
	catalog.pruning = pruning;
	await writeCatalog(store, catalog);
	for (const { backupId, keys } of pruning) {
		for (const key of keys) await store.delete(key);
		const current = parseCatalog(await readText(store, catalogKey));
		current.pruning = (current.pruning ?? []).filter((entry) => entry.backupId !== backupId);
		await writeCatalog(store, current);
		report(`deleted ${backupId} (${keys.length} objects)`);
	}
	return pruning.map(({ backupId }) => backupId);
};

// Interrupted prunes recorded in the catalog, still to finish.
export const pendingPrunes = async (store: BackupStore) =>
	(parseCatalog(await readText(store, catalogKey)).pruning ?? []).map(({ backupId }) => backupId);
