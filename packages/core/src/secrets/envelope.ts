import type { SecretEnvelope } from "@takebase/contracts";
import { nonceBytes, SecretError, tagBytes } from "./crypto.ts";

// The stored form of one secret. Envelopes are validated in full before any
// decryption: exact fields, known version and algorithm, a positive integer
// key version, a 12-byte nonce and at least a tag's worth of ciphertext.

const base64urlPattern = /^[A-Za-z0-9_-]*$/;

export const toBase64url = (bytes: Uint8Array) => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

// Strict: only the unpadded base64url alphabet, and a canonical encoding.
export const fromBase64url = (text: string) => {
	if (!base64urlPattern.test(text) || text.length % 4 === 1) throw new SecretError("invalid_envelope");
	const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	if (toBase64url(bytes) !== text) throw new SecretError("invalid_envelope");
	return bytes;
};

export const toEnvelope = (keyVersion: number, nonce: Uint8Array, ciphertext: Uint8Array): SecretEnvelope => ({
	v: 1,
	alg: "A256GCM",
	kv: keyVersion,
	n: toBase64url(nonce),
	c: toBase64url(ciphertext),
});

const envelopeKeys = ["alg", "c", "kv", "n", "v"];

export type ParsedEnvelope = { keyVersion: number; nonce: Uint8Array; ciphertext: Uint8Array };

export const parseEnvelope = (text: string): ParsedEnvelope => {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new SecretError("invalid_envelope");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SecretError("invalid_envelope");
	const envelope = value as Record<string, unknown>;
	const valid =
		Object.keys(envelope).sort().join() === envelopeKeys.join() &&
		envelope.v === 1 &&
		envelope.alg === "A256GCM" &&
		Number.isSafeInteger(envelope.kv) &&
		(envelope.kv as number) > 0 &&
		typeof envelope.n === "string" &&
		typeof envelope.c === "string";
	if (!valid) throw new SecretError("invalid_envelope");
	const nonce = fromBase64url(envelope.n as string);
	const ciphertext = fromBase64url(envelope.c as string);
	if (nonce.byteLength !== nonceBytes || ciphertext.byteLength < tagBytes) throw new SecretError("invalid_envelope");
	return { keyVersion: envelope.kv as number, nonce, ciphertext };
};
