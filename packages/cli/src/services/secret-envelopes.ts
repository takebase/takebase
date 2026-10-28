import { webcrypto } from "node:crypto";

// The CLI's copy of the tenant secret envelope (packages/core/src/secrets):
// the CLI has no runtime dependencies and never imports @takebase/core, so key
// rotation re-encrypts with this copy. tests/security/secret-rotation.test.ts
// keeps the two in step: each opens what the other seals. Same rules as core:
// AES-256-GCM, a fresh random 96-bit nonce per encryption, the full tag, the
// length-prefixed binding as additional data, and the envelope validated in
// full before anything is decrypted.

export type EnvelopeErrorCode = "invalid_key" | "invalid_envelope" | "decryption_failed";

const messages: Record<EnvelopeErrorCode, string> = {
	invalid_key: "A data key is not 32 bytes of base64",
	invalid_envelope: "The stored secret is not a valid envelope",
	decryption_failed: "The secret could not be decrypted",
};

// A fixed message per code: never key material, plaintext or why decryption failed.
export class EnvelopeError extends Error {
	readonly code: EnvelopeErrorCode;
	constructor(code: EnvelopeErrorCode) {
		super(messages[code]);
		this.name = "EnvelopeError";
		this.code = code;
	}
}

export type DataKey = webcrypto.CryptoKey;

export type SecretBinding = {
	tenantId: string;
	environment: string;
	keyVersion: number;
	purpose: string;
	name: string;
};

const nonceBytes = 12;
const tagBytes = 16;
const aadLabel = "takebase-secret/v1";
const keyPattern = /^[A-Za-z0-9+/]{43}=$/;
const base64urlPattern = /^[A-Za-z0-9_-]*$/;
const envelopeKeys = ["alg", "c", "kv", "n", "v"];

// Imported non-extractable from the keys file's base64 form.
export const importDataKey = async (base64: string): Promise<DataKey> => {
	const raw = Buffer.from(base64, "base64");
	if (!keyPattern.test(base64) || raw.byteLength !== 32) throw new EnvelopeError("invalid_key");
	try {
		return await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
	} finally {
		raw.fill(0);
	}
};

export const secretAad = ({ tenantId, environment, keyVersion, purpose, name }: SecretBinding) => {
	const fields = [aadLabel, tenantId, environment, String(keyVersion), purpose, name].map((field) =>
		Buffer.from(field, "utf8"),
	);
	const out = Buffer.alloc(fields.reduce((total, field) => total + 4 + field.byteLength, 0));
	let offset = 0;
	for (const field of fields) {
		out.writeUInt32BE(field.byteLength, offset);
		field.copy(out, offset + 4);
		offset += 4 + field.byteLength;
	}
	return out;
};

const toBase64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

// Strict: only the unpadded base64url alphabet, and a canonical encoding.
const fromBase64url = (text: string) => {
	if (!base64urlPattern.test(text) || text.length % 4 === 1) throw new EnvelopeError("invalid_envelope");
	const bytes = Buffer.from(text, "base64url");
	if (toBase64url(bytes) !== text) throw new EnvelopeError("invalid_envelope");
	return bytes;
};

export type ParsedEnvelope = { keyVersion: number; nonce: Uint8Array; ciphertext: Uint8Array };

export const parseEnvelope = (text: string): ParsedEnvelope => {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new EnvelopeError("invalid_envelope");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EnvelopeError("invalid_envelope");
	const envelope = value as Record<string, unknown>;
	const valid =
		Object.keys(envelope).sort().join() === envelopeKeys.join() &&
		envelope.v === 1 &&
		envelope.alg === "A256GCM" &&
		Number.isSafeInteger(envelope.kv) &&
		(envelope.kv as number) > 0 &&
		typeof envelope.n === "string" &&
		typeof envelope.c === "string";
	if (!valid) throw new EnvelopeError("invalid_envelope");
	const nonce = fromBase64url(envelope.n as string);
	const ciphertext = fromBase64url(envelope.c as string);
	if (nonce.byteLength !== nonceBytes || ciphertext.byteLength < tagBytes) throw new EnvelopeError("invalid_envelope");
	return { keyVersion: envelope.kv as number, nonce, ciphertext };
};

// The stored JSON envelope of `plaintext`, sealed with a fresh nonce.
export const sealEnvelope = async (key: DataKey, binding: SecretBinding, plaintext: Uint8Array) => {
	const nonce = webcrypto.getRandomValues(new Uint8Array(nonceBytes));
	const ciphertext = new Uint8Array(
		await webcrypto.subtle.encrypt(
			{ name: "AES-GCM", iv: nonce, additionalData: secretAad(binding), tagLength: tagBytes * 8 },
			key,
			plaintext as Uint8Array<ArrayBuffer>,
		),
	);
	return JSON.stringify({
		v: 1,
		alg: "A256GCM",
		kv: binding.keyVersion,
		n: toBase64url(nonce),
		c: toBase64url(ciphertext),
	});
};

export const openEnvelope = async (key: DataKey, binding: SecretBinding, envelope: ParsedEnvelope) => {
	try {
		return new Uint8Array(
			await webcrypto.subtle.decrypt(
				{
					name: "AES-GCM",
					iv: envelope.nonce as Uint8Array<ArrayBuffer>,
					additionalData: secretAad(binding),
					tagLength: tagBytes * 8,
				},
				key,
				envelope.ciphertext as Uint8Array<ArrayBuffer>,
			),
		);
	} catch {
		throw new EnvelopeError("decryption_failed");
	}
};
