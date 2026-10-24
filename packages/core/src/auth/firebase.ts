import { type IdentityProvider, InvalidTokenError } from "./identity-provider.ts";

// Firebase ID tokens verified offline with WebCrypto, as Firebase documents for
// third-party JWT libraries: RS256 signature by Google's securetoken keys, then
// issuer, audience, expiry, issue/auth time and subject. No Admin SDK.
// Offline verification cannot see a revoked or disabled user before the token
// expires (at most one hour after issue).

export type FirebaseSettings = { projectId: string; emulator: boolean };

// The Worker variables these settings come from. TAKEBASE_AUTH_EMULATOR is set
// only in local test bindings or .dev.vars, never in wrangler.jsonc.
export type FirebaseVars = { FIREBASE_PROJECT_ID?: string; TAKEBASE_AUTH_EMULATOR?: string };

const emulatorSetting = "local-only";
const projectIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

// The Auth emulator issues unsigned tokens. Trusting them needs both the
// explicit local-only setting and a demo-* project, which Firebase never
// connects to real services. Any other combination throws, so a misconfigured
// Worker fails every request instead of accepting unsigned tokens.
export const firebaseSettings = (vars: FirebaseVars): FirebaseSettings => {
	const projectId = vars.FIREBASE_PROJECT_ID ?? "";
	if (!projectIdPattern.test(projectId)) throw new Error("FIREBASE_PROJECT_ID is missing or invalid");
	const setting = vars.TAKEBASE_AUTH_EMULATOR;
	if (setting === undefined || setting === "") return { projectId, emulator: false };
	if (setting !== emulatorSetting) throw new Error(`TAKEBASE_AUTH_EMULATOR must be "${emulatorSetting}" or unset`);
	if (!projectId.startsWith("demo-")) throw new Error("Auth emulator trust requires a demo-* Firebase project");
	return { projectId, emulator: true };
};

// Signing keys by key id, valid until `now` passes their cache lifetime.
export type SigningKeys = (now: Date) => Promise<Map<string, CryptoKey>>;

type Jwk = { kty?: string; kid?: string; n?: string; e?: string };

const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export const importSigningKeys = async (jwks: Jwk[]) => {
	const keys = new Map<string, CryptoKey>();
	for (const { kty, kid, n, e } of jwks) {
		if (kty !== "RSA" || typeof kid !== "string" || !n || !e) continue;
		keys.set(kid, await crypto.subtle.importKey("jwk", { kty, n, e }, algorithm, false, ["verify"]));
	}
	return keys;
};

const googleKeysUrl = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

// Google's public keys are the same for every request, tenant and user, so one
// copy per isolate is safe; it holds no request data. It is refreshed only once
// the Cache-Control lifetime passes, never per unknown key id, so forged key
// ids cannot make the Worker fetch on every request.
let googleKeys: { keys: Map<string, CryptoKey>; expiresAt: number } | undefined;

const maxAgeSeconds = (cacheControl: string | null) => Number(/max-age=(\d+)/.exec(cacheControl ?? "")?.[1] ?? 0);

export const googleSigningKeys: SigningKeys = async (now) => {
	if (googleKeys && googleKeys.expiresAt > now.getTime()) return googleKeys.keys;
	const response = await fetch(googleKeysUrl);
	if (!response.ok) throw new Error(`Could not fetch Firebase signing keys (${response.status})`);
	const { keys } = (await response.json()) as { keys: Jwk[] };
	const imported = await importSigningKeys(keys);
	googleKeys = {
		keys: imported,
		expiresAt: now.getTime() + maxAgeSeconds(response.headers.get("cache-control")) * 1000,
	};
	return imported;
};

const decodeBase64Url = (segment: string) => {
	const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (char) => char.charCodeAt(0));
};

const decodeJson = (segment: string): Record<string, unknown> => {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
		if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {}
	throw new InvalidTokenError("malformed token");
};

const clockSkewSeconds = 300;

const checkClaims = (claims: Record<string, unknown>, projectId: string, now: Date) => {
	const seconds = now.getTime() / 1000;
	const { iss, aud, exp, iat, auth_time, sub } = claims;
	if (iss !== `https://securetoken.google.com/${projectId}`) throw new InvalidTokenError("wrong issuer");
	if (aud !== projectId) throw new InvalidTokenError("wrong audience");
	if (typeof exp !== "number" || exp <= seconds) throw new InvalidTokenError("expired");
	if (typeof iat !== "number" || iat > seconds + clockSkewSeconds) throw new InvalidTokenError("issued in the future");
	if (typeof auth_time !== "number" || auth_time > seconds + clockSkewSeconds) {
		throw new InvalidTokenError("authenticated in the future");
	}
	if (typeof sub !== "string" || sub.length === 0 || sub.length > 128) throw new InvalidTokenError("invalid subject");
	return sub;
};

export type FirebaseProviderOptions = FirebaseSettings & { keys?: SigningKeys };

export const firebaseProvider = ({ projectId, emulator, keys = googleSigningKeys }: FirebaseProviderOptions) => {
	const verifySignature = async (header: Record<string, unknown>, signed: string, signature: string, now: Date) => {
		if (header.alg !== "RS256" || typeof header.kid !== "string") throw new InvalidTokenError("unsupported algorithm");
		const key = (await keys(now)).get(header.kid);
		if (!key) throw new InvalidTokenError("unknown signing key");
		const valid = await crypto.subtle.verify(
			algorithm,
			key,
			decodeBase64Url(signature),
			new TextEncoder().encode(signed),
		);
		if (!valid) throw new InvalidTokenError("bad signature");
	};

	const provider: IdentityProvider = {
		name: "firebase",
		verify: async (token, now) => {
			const [header, payload, signature, ...rest] = token.split(".");
			if (header === undefined || payload === undefined || signature === undefined || rest.length > 0) {
				throw new InvalidTokenError("malformed token");
			}
			const decodedHeader = decodeJson(header);
			// Emulator tokens are unsigned (alg "none"); outside emulator mode only
			// a verified RS256 signature is accepted.
			if (emulator) {
				if (decodedHeader.alg !== "none") throw new InvalidTokenError("unsupported algorithm");
			} else {
				await verifySignature(decodedHeader, `${header}.${payload}`, signature, now);
			}
			return { provider: "firebase", subject: checkClaims(decodeJson(payload), projectId, now) };
		},
	};
	return provider;
};
