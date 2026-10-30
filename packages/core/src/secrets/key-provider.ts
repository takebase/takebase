import { importDataKey, SecretError } from "./crypto.ts";

// Data keys come from the tenant Worker's secrets: `DATA_KEY_V<n>` holds
// version n as standard base64 of 32 random bytes (`openssl rand -base64 32`),
// and the `DATA_KEY_VERSION` var names the version new secrets use. Built per
// request by the composition root; imported keys live only in this closure.

export type DataKeys = {
	// The version new secrets are encrypted with, or null when none is configured.
	current: number | null;
	// The versions with a key installed, ascending: names only, nothing imported.
	installed: number[];
	// The imported key for a version; throws `missing_key` when not installed.
	key: (version: number) => Promise<CryptoKey>;
};

const versionPattern = /^[1-9][0-9]{0,8}$/;
const installedPattern = /^DATA_KEY_V([1-9][0-9]{0,8})$/;
const base64Pattern = /^[A-Za-z0-9+/]{43}=$/;

const decodeKey = (text: string) => {
	if (!base64Pattern.test(text.trim())) throw new SecretError("invalid_key");
	return Uint8Array.from(atob(text.trim()), (char) => char.charCodeAt(0));
};

export const dataKeysFrom = (env: Record<string, unknown>): DataKeys => {
	const configured = env.DATA_KEY_VERSION;
	const current = typeof configured === "string" && versionPattern.test(configured) ? Number(configured) : null;
	const imported = new Map<number, Promise<CryptoKey>>();
	const installed = Object.entries(env)
		.map(([name, value]) => [installedPattern.exec(name)?.[1], value] as const)
		.filter(([version, value]) => version !== undefined && typeof value === "string" && value !== "")
		.map(([version]) => Number(version))
		.sort((a, b) => a - b);
	return {
		current,
		installed,
		key: (version) => {
			const cached = imported.get(version);
			if (cached) return cached;
			const raw = env[`DATA_KEY_V${version}`];
			if (typeof raw !== "string" || raw === "") return Promise.reject(new SecretError("missing_key"));
			const key = (async () => importDataKey(decodeKey(raw)))();
			imported.set(version, key);
			return key;
		},
	};
};
