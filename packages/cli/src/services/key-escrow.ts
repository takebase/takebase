import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../errors.ts";
import type { EnvironmentConfig } from "../project-config.ts";
import { addSecret, readSecretsFile } from "../secrets-file.ts";
import { storedKeyName, workerKeyName } from "./key-names.ts";
import { type EnvelopeStore, type KeyRing, type RotationScope, verifySecrets } from "./key-rotation.ts";
import { importDataKey } from "./secret-envelopes.ts";

// Recovery escrow for tenant data keys (SEGU-224). Without its key a tenant's
// secrets are lost, so every key is deposited in an escrow outside this
// machine before it is installed, and a lost key is withdrawn from there.
//
// `KeyEscrow` is the boundary a real key manager (OpenBao or another,
// explicitly selected) will implement. None is selected yet; Takebase ships:
// - the keys file itself (the stand-in every environment already has);
// - a directory escrow, which simulates an external one in tests and journeys.
// Escrows never replace a deposited key and never print one.

export type EscrowEntry = { tenantId: string; version: number };

export type KeyEscrow = {
	// What it is, for output: never a key.
	label: string;
	has: (entry: EscrowEntry) => Promise<boolean>;
	// Refuses an entry that already holds a key.
	deposit: (entry: EscrowEntry, key: string) => Promise<void>;
	// The key, or null when the escrow has none.
	withdraw: (entry: EscrowEntry) => Promise<string | null>;
};

// The environment's keys file, as `DATA_KEY_V<n>_<TENANT>` lines.
export const keysFileEscrow = (path: string): KeyEscrow => {
	const value = ({ tenantId, version }: EscrowEntry) => readSecretsFile(path).values[storedKeyName(tenantId, version)];
	return {
		label: `keys file ${path}`,
		has: async (entry) => value(entry) !== undefined,
		deposit: async (entry, key) => addSecret(path, storedKeyName(entry.tenantId, entry.version), key),
		withdraw: async (entry) => value(entry) ?? null,
	};
};

// One mode-600 file per key in a mode-700 directory, for one environment.
// It stands in for an external escrow: tests and journeys keep it apart from
// the keys file so losing one proves recovery from the other.
export const directoryEscrow = (dir: string, environment: string): KeyEscrow => {
	const file = ({ tenantId, version }: EscrowEntry) =>
		join(dir, `${environment}-${storedKeyName(tenantId, version)}.key`);
	return {
		label: `escrow directory ${dir}`,
		has: async (entry) => existsSync(file(entry)),
		deposit: async (entry, key) => {
			if (existsSync(file(entry))) {
				throw new CliError(`The escrow already holds ${storedKeyName(entry.tenantId, entry.version)}`, {
					hint: "An escrowed key is never replaced. Nothing was changed.",
				});
			}
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			chmodSync(dir, 0o700);
			writeFileSync(file(entry), `${key}\n`, { mode: 0o600, flag: "wx" });
		},
		withdraw: async (entry) => (existsSync(file(entry)) ? readFileSync(file(entry), "utf8").trim() : null),
	};
};

// The environment's escrow (`escrowDir` in takebase.jsonc), or null without one.
export const environmentEscrow = (environment: EnvironmentConfig): KeyEscrow | null =>
	environment.escrowDir === undefined ? null : directoryEscrow(environment.escrowDir, environment.name);

export type Recovery = {
	tenantId: string;
	version: number;
	// "present" when the keys file already had the key and nothing was restored.
	outcome: "present" | "restored";
	// Secrets on this version that the key was proven to open before it was restored.
	opened: number;
};

// Restores one lost key into the keys file from the escrow. The escrowed key
// must first open every secret stored under its version; a key that does not
// is refused and nothing is written. Installing it on a remote Worker is the
// caller's next step.
export const recoverKey = async ({
	escrow,
	keysFile,
	store,
	scope,
	version,
}: {
	escrow: KeyEscrow;
	keysFile: string;
	store: EnvelopeStore;
	scope: RotationScope;
	version: number;
}): Promise<Recovery> => {
	const entry = { tenantId: scope.tenantId, version };
	const name = storedKeyName(scope.tenantId, version);
	if (readSecretsFile(keysFile).values[name] !== undefined) {
		return { tenantId: scope.tenantId, version, outcome: "present", opened: 0 };
	}
	const key = await escrow.withdraw(entry);
	if (key === null) {
		throw new CliError(`The ${escrow.label} has no ${name}`, {
			hint: `Without ${workerKeyName(version)} the secrets it encrypted cannot be recovered. Nothing was changed.`,
		});
	}
	const imported = importDataKey(key);
	const ring: KeyRing = (wanted) =>
		wanted === version ? imported : Promise.reject(new CliError(`not recovering v${wanted}`));
	const proof = await verifySecrets({ store, keys: ring, scope, target: version });
	if (proof.rejected > 0) {
		throw new CliError(`The escrowed ${name} does not open ${proof.rejected} secret(s) stored under it`, {
			hint: "It is not the key these secrets were encrypted with. Nothing was changed.",
		});
	}
	addSecret(keysFile, name, key);
	return { tenantId: scope.tenantId, version, outcome: "restored", opened: proof.onTarget };
};
