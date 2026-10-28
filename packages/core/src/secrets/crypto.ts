// AES-256-GCM for tenant secrets (WebCrypto, as in Workers). A fresh random
// 96-bit nonce per encryption, the full 128-bit tag, and additional
// authenticated data that binds the ciphertext to its tenant, environment,
// key version, purpose and name, so it cannot be moved or replayed elsewhere.

export const keyBytes = 32;
export const nonceBytes = 12;
export const tagBytes = 16;

// Every failure carries one of these codes and a fixed message: never key
// material, plaintext or the reason a decryption failed.
export type SecretErrorCode = "invalid_key" | "missing_key" | "invalid_envelope" | "invalid_name" | "decryption_failed";

const messages: Record<SecretErrorCode, string> = {
	invalid_key: "A data key is not 32 bytes of base64",
	missing_key: "The data key this secret needs is not installed",
	invalid_envelope: "The stored secret is not a valid envelope",
	invalid_name: "Secret purposes and names are 1-64 of a-z, 0-9, '.', '_' and '-'",
	decryption_failed: "The secret could not be decrypted",
};

export class SecretError extends Error {
	readonly code: SecretErrorCode;
	constructor(code: SecretErrorCode) {
		super(messages[code]);
		this.name = "SecretError";
		this.code = code;
	}
}

// Imported non-extractable: the raw bytes cannot be read back from the key.
export const importDataKey = async (raw: Uint8Array) => {
	if (raw.byteLength !== keyBytes) throw new SecretError("invalid_key");
	return crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
};

export type SecretBinding = {
	tenantId: string;
	environment: string;
	keyVersion: number;
	purpose: string;
	name: string;
};

const aadLabel = "takebase-secret/v1";

// Length-prefixed fields (4-byte big-endian length, then UTF-8), so no two
// different bindings can encode to the same bytes.
export const secretAad = ({ tenantId, environment, keyVersion, purpose, name }: SecretBinding) => {
	const fields = [aadLabel, tenantId, environment, String(keyVersion), purpose, name].map((field) =>
		new TextEncoder().encode(field),
	);
	const out = new Uint8Array(fields.reduce((total, field) => total + 4 + field.byteLength, 0));
	const view = new DataView(out.buffer);
	let offset = 0;
	for (const field of fields) {
		view.setUint32(offset, field.byteLength);
		out.set(field, offset + 4);
		offset += 4 + field.byteLength;
	}
	return out;
};

export const seal = async (key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array) => {
	const nonce = crypto.getRandomValues(new Uint8Array(nonceBytes));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: nonce, additionalData: aad as Uint8Array<ArrayBuffer>, tagLength: tagBytes * 8 },
			key,
			plaintext as Uint8Array<ArrayBuffer>,
		),
	);
	return { nonce, ciphertext };
};

export const open = async (key: CryptoKey, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array) => {
	try {
		return new Uint8Array(
			await crypto.subtle.decrypt(
				{
					name: "AES-GCM",
					iv: nonce as Uint8Array<ArrayBuffer>,
					additionalData: aad as Uint8Array<ArrayBuffer>,
					tagLength: tagBytes * 8,
				},
				key,
				ciphertext as Uint8Array<ArrayBuffer>,
			),
		);
	} catch {
		throw new SecretError("decryption_failed");
	}
};
