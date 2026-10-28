// Encrypted tenant secrets (SEGU-223). Only ciphertext envelopes and metadata
// ever leave a tenant Worker's memory: plaintext and data keys never do.

// What KV stores for one secret: AES-256-GCM ciphertext with its tag (`c`),
// the 96-bit nonce (`n`), both base64url, and the data key version (`kv`).
// The additional authenticated data is never stored: the Worker rebuilds it
// from its own tenant, environment and the secret's purpose and name.
export type SecretEnvelope = {
	v: 1;
	alg: "A256GCM";
	kv: number;
	n: string;
	c: string;
};

// One stored secret, as status shows it: never its value.
export type SecretMetadata = {
	purpose: string;
	name: string;
	keyVersion: number;
	updated: string;
};

// Whether a tenant Worker can decrypt its secrets:
// - ok: the installed key opens the key-check canary;
// - unconfigured: no KV binding or no active key version;
// - missing_key: a key version is configured but its key is not installed;
// - mismatch: the installed key does not open what KV holds.
export type SecretsState = "ok" | "unconfigured" | "missing_key" | "mismatch";
