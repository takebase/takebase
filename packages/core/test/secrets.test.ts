import { describe, expect, it } from "vitest";
import { createSecretsService, dataKeysFrom, SecretError, type SecretsKv } from "../src/index.ts";
import { fromBase64url, toBase64url } from "../src/secrets/envelope.ts";

// Keys are random per run, assembled here: no key-shaped literal is committed.
const randomKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

// An in-memory KV namespace exposing what was stored, so tests can inspect it.
const memoryKv = () => {
	const store = new Map<string, { value: string; metadata?: unknown }>();
	const kv: SecretsKv = {
		get: async (key) => store.get(key)?.value ?? null,
		put: async (key, value, options) => {
			store.set(key, { value, metadata: options?.metadata });
		},
		list: async ({ prefix }) => ({
			keys: [...store].filter(([name]) => name.startsWith(prefix)).map(([name, { metadata }]) => ({ name, metadata })),
			list_complete: true,
		}),
	};
	return { kv, store };
};

type Setup = { tenantId?: string; environment?: string; env?: Record<string, unknown>; kv?: SecretsKv };
const service = ({ tenantId = "tenant-a", environment = "local", env = {}, kv = memoryKv().kv }: Setup) =>
	createSecretsService({ kv, keys: dataKeysFrom(env), tenantId, environment, now: () => new Date(0) });

const failure = async (promise: Promise<unknown>) => {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(SecretError);
	return (error as SecretError).code;
};

// Rewrites one field of a stored envelope.
const tamper = (stored: string, change: (envelope: Record<string, unknown>) => void) => {
	const envelope = JSON.parse(stored) as Record<string, unknown>;
	change(envelope);
	return JSON.stringify(envelope);
};
const flipFirstByte = (text: string) => {
	const bytes = fromBase64url(text);
	bytes[0] = (bytes[0] ?? 0) ^ 1;
	return toBase64url(bytes);
};
const flipLastByte = (text: string) => {
	const bytes = fromBase64url(text);
	bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
	return toBase64url(bytes);
};

describe("tenant secrets", () => {
	it("round-trips with a fresh nonce, and KV holds only ciphertext and metadata", async () => {
		const key = randomKey();
		const plaintext = `value-${crypto.randomUUID()}`;
		const { kv, store } = memoryKv();
		const secrets = service({ env: { DATA_KEY_VERSION: "1", DATA_KEY_V1: key }, kv });

		await secrets.put("app", "smtp", plaintext);
		const first = store.get("secret/app/smtp")?.value ?? "";
		await secrets.put("app", "smtp", plaintext);
		const second = store.get("secret/app/smtp")?.value ?? "";
		expect(JSON.parse(first).n).not.toBe(JSON.parse(second).n);
		expect(await secrets.get("app", "smtp")).toBe(plaintext);
		expect(await secrets.get("app", "missing")).toBeNull();
		expect(await secrets.status()).toEqual([
			{ purpose: "app", name: "smtp", keyVersion: 1, updated: new Date(0).toISOString() },
		]);

		const dump = JSON.stringify([...store]);
		const keyHex = [...atob(key)].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
		for (const leak of [plaintext, key, toBase64url(Uint8Array.from(atob(key), (c) => c.charCodeAt(0))), keyHex]) {
			expect(dump).not.toContain(leak);
		}
	});

	it("rejects a tampered nonce, tag, ciphertext or AAD", async () => {
		const { kv, store } = memoryKv();
		const secrets = service({ env: { DATA_KEY_VERSION: "1", DATA_KEY_V1: randomKey() }, kv });
		await secrets.put("app", "smtp", "plaintext");
		const stored = store.get("secret/app/smtp")?.value ?? "";
		const replace = (value: string, key = "secret/app/smtp") => store.set(key, { value });

		for (const changed of [
			tamper(stored, (envelope) => (envelope.n = flipFirstByte(envelope.n as string))),
			tamper(stored, (envelope) => (envelope.c = flipLastByte(envelope.c as string))),
			tamper(stored, (envelope) => (envelope.c = flipFirstByte(envelope.c as string))),
		]) {
			replace(changed);
			expect(await failure(secrets.get("app", "smtp"))).toBe("decryption_failed");
		}
		// The AAD is rebuilt from purpose and name: a moved envelope fails.
		replace(stored, "secret/app/other");
		replace(stored, "secret/billing/smtp");
		expect(await failure(secrets.get("app", "other"))).toBe("decryption_failed");
		expect(await failure(secrets.get("billing", "smtp"))).toBe("decryption_failed");
		// Malformed envelopes are refused before any decryption.
		for (const changed of [
			"not json",
			tamper(stored, (envelope) => (envelope.extra = 1)),
			tamper(stored, (envelope) => (envelope.alg = "A128GCM")),
			tamper(stored, (envelope) => (envelope.n = toBase64url(new Uint8Array(8)))),
			tamper(stored, (envelope) => (envelope.c = "AAAA")),
			tamper(stored, (envelope) => (envelope.n = `${envelope.n}=`)),
		]) {
			replace(changed);
			expect(await failure(secrets.get("app", "smtp"))).toBe("invalid_envelope");
		}
	});

	it("rejects ciphertext from another tenant, environment or key version", async () => {
		const key = randomKey();
		const env = { DATA_KEY_VERSION: "1", DATA_KEY_V1: key, DATA_KEY_V2: key };
		const { kv, store } = memoryKv();
		await service({ env, kv }).put("app", "smtp", "plaintext");
		const stored = store.get("secret/app/smtp")?.value ?? "";

		// Even with the same key, another tenant or environment cannot open it.
		expect(await failure(service({ tenantId: "tenant-b", env, kv }).get("app", "smtp"))).toBe("decryption_failed");
		expect(await failure(service({ environment: "staging", env, kv }).get("app", "smtp"))).toBe("decryption_failed");
		// Relabelling the key version breaks the AAD; a version with no key installed fails closed.
		store.set("secret/app/smtp", { value: tamper(stored, (envelope) => (envelope.kv = 2)) });
		expect(await failure(service({ env, kv }).get("app", "smtp"))).toBe("decryption_failed");
		store.set("secret/app/smtp", { value: tamper(stored, (envelope) => (envelope.kv = 3)) });
		expect(await failure(service({ env, kv }).get("app", "smtp"))).toBe("missing_key");
		// A different key under the same version cannot open it.
		store.set("secret/app/smtp", { value: stored });
		const other = { DATA_KEY_VERSION: "1", DATA_KEY_V1: randomKey() };
		expect(await failure(service({ env: other, kv }).get("app", "smtp"))).toBe("decryption_failed");
	});

	it("checks the installed key with the canary and fails closed without one", async () => {
		const key = randomKey();
		const { kv } = memoryKv();
		expect(await service({ kv }).check()).toBe("unconfigured");
		expect(await service({ env: { DATA_KEY_VERSION: "1" }, kv }).check()).toBe("missing_key");
		expect(await failure(service({ env: { DATA_KEY_VERSION: "1" }, kv }).put("app", "smtp", "x"))).toBe("missing_key");
		expect(await service({ env: { DATA_KEY_VERSION: "1", DATA_KEY_V1: key }, kv }).check()).toBe("ok");
		expect(await service({ env: { DATA_KEY_VERSION: "1", DATA_KEY_V1: key }, kv }).check()).toBe("ok");
		expect(await service({ env: { DATA_KEY_VERSION: "1", DATA_KEY_V1: randomKey() }, kv }).check()).toBe("mismatch");
	});

	it("refuses malformed keys and names without echoing them", async () => {
		const short = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
		const { kv } = memoryKv();
		const error = await service({ env: { DATA_KEY_VERSION: "1", DATA_KEY_V1: short }, kv })
			.put("app", "smtp", "x")
			.catch((caught: unknown) => caught as Error);
		expect((error as SecretError).code).toBe("invalid_key");
		expect((error as Error).message).not.toContain(short);
		expect(await service({ env: { DATA_KEY_VERSION: "1", DATA_KEY_V1: short }, kv }).check()).toBe("missing_key");
		const secrets = service({ env: { DATA_KEY_VERSION: "1", DATA_KEY_V1: randomKey() }, kv });
		expect(await failure(secrets.put("app", "../smtp", "x"))).toBe("invalid_name");
		expect(await failure(secrets.get("App", "smtp"))).toBe("invalid_name");
	});
});
