import type { SecretMetadata, SecretsState } from "@takebase/contracts";
import { open, SecretError, seal, secretAad } from "../secrets/crypto.ts";
import { parseEnvelope, toEnvelope } from "../secrets/envelope.ts";
import type { DataKeys } from "../secrets/key-provider.ts";

// All KV access for a tenant's encrypted secrets. KV holds only envelopes
// (`secret/<purpose>/<name>`) and metadata; plaintext exists only in the
// memory of the call that encrypts or decrypts it. Worker-internal: no HTTP
// route accepts or returns a secret value.

// The part of a KV namespace binding this service uses.
export type SecretsKv = {
	get: (key: string) => Promise<string | null>;
	put: (key: string, value: string, options?: { metadata?: unknown }) => Promise<void>;
	list: (options: {
		prefix: string;
		cursor?: string | null;
	}) => Promise<{ keys: { name: string; metadata?: unknown }[]; list_complete: boolean; cursor?: string }>;
};

export type SecretsServiceOptions = {
	kv: SecretsKv;
	keys: DataKeys;
	tenantId: string;
	environment: string;
	now: () => Date;
};

const namePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const prefix = "secret/";
const maxPlaintextBytes = 64 * 1024;

// The key-check canary: random bytes whose only use is proving the installed
// key opens what KV holds.
export const keyCheckPurpose = "key-check";
const keyCheckName = "canary";

const kvKey = (purpose: string, name: string) => {
	if (!namePattern.test(purpose) || !namePattern.test(name)) throw new SecretError("invalid_name");
	return `${prefix}${purpose}/${name}`;
};

const isMetadata = (value: unknown): value is { kv: number; updated: string } =>
	typeof value === "object" &&
	value !== null &&
	Number.isSafeInteger((value as { kv?: unknown }).kv) &&
	typeof (value as { updated?: unknown }).updated === "string";

export const createSecretsService = ({ kv, keys, tenantId, environment, now }: SecretsServiceOptions) => {
	const binding = (keyVersion: number, purpose: string, name: string) =>
		secretAad({ tenantId, environment, keyVersion, purpose, name });

	const putBytes = async (purpose: string, name: string, plaintext: Uint8Array): Promise<SecretMetadata> => {
		const key = kvKey(purpose, name);
		if (plaintext.byteLength > maxPlaintextBytes) throw new RangeError("A secret is at most 64 KiB");
		const version = keys.current;
		if (version === null) throw new SecretError("missing_key");
		const { nonce, ciphertext } = await seal(await keys.key(version), plaintext, binding(version, purpose, name));
		const updated = now().toISOString();
		await kv.put(key, JSON.stringify(toEnvelope(version, nonce, ciphertext)), { metadata: { kv: version, updated } });
		return { purpose, name, keyVersion: version, updated };
	};

	// Null when the secret does not exist; throws a SecretError when it cannot
	// be decrypted (tampered, moved, or its key is not installed).
	const getBytes = async (purpose: string, name: string) => {
		const stored = await kv.get(kvKey(purpose, name));
		if (stored === null) return null;
		const { keyVersion, nonce, ciphertext } = parseEnvelope(stored);
		return open(await keys.key(keyVersion), nonce, ciphertext, binding(keyVersion, purpose, name));
	};

	const put = (purpose: string, name: string, value: string) =>
		putBytes(purpose, name, new TextEncoder().encode(value));

	const get = async (purpose: string, name: string) => {
		const bytes = await getBytes(purpose, name);
		return bytes === null ? null : new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	};

	// Metadata of every stored secret, from KV metadata alone: nothing is decrypted.
	const status = async (): Promise<SecretMetadata[]> => {
		const items: SecretMetadata[] = [];
		let cursor: string | undefined;
		do {
			const page = await kv.list({ prefix, cursor });
			for (const { name, metadata } of page.keys) {
				const [purpose = "", secret = ""] = name.slice(prefix.length).split("/");
				if (!isMetadata(metadata)) continue;
				items.push({ purpose, name: secret, keyVersion: metadata.kv, updated: metadata.updated });
			}
			cursor = page.list_complete ? undefined : page.cursor;
		} while (cursor !== undefined);
		return items;
	};

	// Writes the canary with the current key when it is missing, then opens it.
	const check = async (): Promise<SecretsState> => {
		if (keys.current === null) return "unconfigured";
		try {
			if ((await kv.get(kvKey(keyCheckPurpose, keyCheckName))) === null) {
				await putBytes(keyCheckPurpose, keyCheckName, crypto.getRandomValues(new Uint8Array(32)));
			}
			await getBytes(keyCheckPurpose, keyCheckName);
			await keys.key(keys.current);
			return "ok";
		} catch (error) {
			if (!(error instanceof SecretError)) throw error;
			// An unusable installed key counts as no key; anything else is data the key cannot open.
			return error.code === "missing_key" || error.code === "invalid_key" ? "missing_key" : "mismatch";
		}
	};

	// Which key versions exist, by name only: no key is imported or returned.
	const keyVersions = () => ({ active: keys.current, installed: [...keys.installed] });

	return { put, get, status, check, keyVersions };
};

export type SecretsService = ReturnType<typeof createSecretsService>;
