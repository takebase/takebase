import type { BackupStore } from "../../packages/cli/src/services/backups.ts";

// An object store in memory for the backup tests (SEGU-225): what the CLI puts
// in R2, keyed the same way, so a test can corrupt, truncate or delete objects.
export const memoryStore = () => {
	const objects = new Map<string, Uint8Array>();
	const store: BackupStore = {
		get: async (key) => objects.get(key) ?? null,
		put: async (key, bytes) => {
			objects.set(key, new Uint8Array(bytes));
		},
		delete: async (key) => {
			objects.delete(key);
		},
	};
	return { objects, store };
};
