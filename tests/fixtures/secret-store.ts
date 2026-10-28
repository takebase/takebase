import { CliError } from "../../packages/cli/src/errors.ts";
import type { EnvelopeStore, KeyRing } from "../../packages/cli/src/services/key-rotation.ts";
import { importDataKey } from "../../packages/cli/src/services/secret-envelopes.ts";
import { createSecretsService, dataKeysFrom, type SecretsKv } from "../../packages/core/src/index.ts";

// Encrypted tenant secrets in memory for the key rotation and recovery tests
// (SEGU-224): one KV namespace seen both as the tenant Worker's binding (its
// own secrets service writes and reads) and as the CLI's envelope store. Keys
// and values are random per run, so no credential-shaped literal is committed.

export const randomKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
export const randomValue = () =>
	`value-${Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url")}`;
export const scope = { tenantId: "tenant-a", environment: "local" };

// One in-memory KV namespace, seen both as the Worker's binding and as the CLI's store.
export const memory = () => {
	const map = new Map<string, { value: string; metadata?: unknown }>();
	const kv: SecretsKv = {
		get: async (key) => map.get(key)?.value ?? null,
		put: async (key, value, options) => {
			map.set(key, { value, metadata: options?.metadata });
		},
		list: async ({ prefix }) => ({
			keys: [...map].filter(([name]) => name.startsWith(prefix)).map(([name, { metadata }]) => ({ name, metadata })),
			list_complete: true,
		}),
	};
	const store: EnvelopeStore = {
		names: async () => [...map.keys()].filter((name) => name.startsWith("secret/")),
		get: kv.get,
		put: (key, value, metadata) => kv.put(key, value, { metadata }),
	};
	return { map, kv, store };
};

export const worker = (kv: SecretsKv, env: Record<string, string>) =>
	createSecretsService({ kv, keys: dataKeysFrom(env), ...scope, now: () => new Date(0) });

export const ring = (keys: Record<number, string>): KeyRing => {
	const imported = new Map<number, ReturnType<typeof importDataKey>>();
	return (version) => {
		const key = keys[version];
		if (key === undefined) return Promise.reject(new CliError(`no key v${version}`));
		if (!imported.has(version)) imported.set(version, importDataKey(key));
		return imported.get(version) as ReturnType<typeof importDataKey>;
	};
};
