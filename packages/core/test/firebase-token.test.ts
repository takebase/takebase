import { describe, expect, it } from "vitest";
import { firebaseProvider, firebaseSettings, importSigningKeys } from "../src/auth/firebase.ts";
import { InvalidTokenError } from "../src/auth/identity-provider.ts";

// Tokens are signed with a test RSA key served through an injected key source,
// exactly as Google's securetoken keys are used in production.
const projectId = "demo-takebase";
const now = new Date("2026-10-24T12:00:00Z");
const seconds = now.getTime() / 1000;

const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const generate = () =>
	crypto.subtle.generateKey({ ...algorithm, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, [
		"sign",
		"verify",
	]);

const signer = await generate();
const impostor = await generate();
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", signer.publicKey)), kid: "key-1" };
const keys = async () => importSigningKeys([publicJwk]);

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

const claims = (overrides: Record<string, unknown> = {}) => ({
	iss: `https://securetoken.google.com/${projectId}`,
	aud: projectId,
	iat: seconds - 60,
	auth_time: seconds - 60,
	exp: seconds + 3600,
	sub: "user-1",
	...overrides,
});

const sign = async (payload: Record<string, unknown>, key = signer.privateKey) => {
	const signed = `${encode({ alg: "RS256", kid: "key-1", typ: "JWT" })}.${encode(payload)}`;
	const signature = await crypto.subtle.sign(algorithm, key, new TextEncoder().encode(signed));
	return `${signed}.${Buffer.from(signature).toString("base64url")}`;
};

// The Auth emulator's token shape: alg "none" and an empty signature.
const unsigned = (payload: Record<string, unknown>) => `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;

const production = firebaseProvider({ projectId, emulator: false, keys });

describe("Firebase ID token verification (R-3-1-01)", () => {
	it("accepts a correctly signed token and derives the identity from its subject", async () => {
		expect(await production.verify(await sign(claims()), now)).toEqual({ provider: "firebase", subject: "user-1" });
	});

	it("rejects forged, expired and wrong-project tokens", async () => {
		const rejected = [
			await sign(claims(), impostor.privateKey),
			await sign(claims({ exp: seconds - 1 })),
			await sign(claims({ aud: "demo-other", iss: "https://securetoken.google.com/demo-other" })),
			unsigned(claims()),
		];
		for (const token of rejected) await expect(production.verify(token, now)).rejects.toThrow(InvalidTokenError);
	});

	it("trusts unsigned emulator tokens only with the local-only setting and a demo project", async () => {
		expect(firebaseSettings({ FIREBASE_PROJECT_ID: projectId })).toEqual({ projectId, emulator: false });
		expect(() =>
			firebaseSettings({ FIREBASE_PROJECT_ID: "real-project", TAKEBASE_AUTH_EMULATOR: "local-only" }),
		).toThrow(/demo-\*/);
		expect(() => firebaseSettings({ FIREBASE_PROJECT_ID: projectId, TAKEBASE_AUTH_EMULATOR: "true" })).toThrow();

		const emulator = firebaseProvider({
			...firebaseSettings({ FIREBASE_PROJECT_ID: projectId, TAKEBASE_AUTH_EMULATOR: "local-only" }),
			keys,
		});
		expect(await emulator.verify(unsigned(claims()), now)).toEqual({ provider: "firebase", subject: "user-1" });
		await expect(emulator.verify(unsigned(claims({ exp: seconds - 1 })), now)).rejects.toThrow(InvalidTokenError);
	});
});
