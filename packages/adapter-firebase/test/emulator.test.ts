import {
	AUTH_EMULATOR_URL,
	createClient,
	EMULATOR_URL,
	FirebaseRtdbError,
	SERVER_TIMESTAMP,
} from "@takebase/firebase-rtdb";
import { beforeAll, describe, expect, it } from "vitest";
import { databaseRules, firebaseRealtime } from "../src/index.ts";

// The rendered rules against the real Auth and Database emulators (R-4-2-01 /
// S-4-2-01). Runs only inside `firebase emulators:exec --only auth,database`,
// which sets the emulator hosts; otherwise skipped. Each run uses a fresh
// namespace whose rules are loaded at runtime with the dispatcher's uid.

const running = Boolean(process.env.FIREBASE_DATABASE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
const namespace = `demo-takebase-adapter-${Date.now()}`;
const password = "local-only-password";

const signUp = async (name: string) => {
	const email = `${name}-${Date.now()}@example.test`;
	const response = await fetch(
		`${AUTH_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password, returnSecureToken: true }),
		},
	);
	if (response.status !== 200) throw new Error("the Auth emulator should create the user");
	const { localId } = (await response.json()) as { localId: string };
	const client = createClient({
		databaseURL: EMULATOR_URL,
		authEmulatorURL: AUTH_EMULATOR_URL,
		emulatorNamespace: namespace,
		email,
		password,
	});
	return { uid: localId, email, client };
};

const code = (promise: Promise<unknown>) =>
	promise.then(
		() => "ok",
		(error: unknown) => (error instanceof FirebaseRtdbError ? error.code : String(error)),
	);

const owner = createClient({ databaseURL: EMULATOR_URL, emulatorNamespace: namespace });

// Rules are emulator settings, not data, so they go through a raw owner request.
const loadRules = async (rules: object) => {
	const response = await fetch(`${EMULATOR_URL}/.settings/rules.json?ns=${namespace}`, {
		method: "PUT",
		headers: { authorization: "Bearer owner" },
		body: JSON.stringify(rules),
	});
	if (response.status !== 200) throw new Error(`rules should load: ${await response.text()}`);
};

describe.skipIf(!running)("Firebase realtime rules on the emulator", () => {
	let dispatcher: Awaited<ReturnType<typeof signUp>>;
	let member: Awaited<ReturnType<typeof signUp>>;
	let outsider: Awaited<ReturnType<typeof signUp>>;
	let adapter: ReturnType<typeof firebaseRealtime>;

	beforeAll(async () => {
		[dispatcher, member, outsider] = await Promise.all([signUp("dispatcher"), signUp("member"), signUp("outsider")]);
		await loadRules(databaseRules(dispatcher.uid));
		adapter = firebaseRealtime({
			databaseURL: EMULATOR_URL,
			apiKey: "demo-api-key",
			email: dispatcher.email,
			password,
			namespace,
		});
	});

	it("only granted members read signals and presence; everything else stays unreadable", async () => {
		await adapter.publish("policies", 3);
		expect(await code(member.client.get("collections"))).toBe("denied");
		await adapter.grant(member.uid, 10);
		expect(await member.client.get("collections")).toEqual({ policies: { revision: 3 } });
		expect(await member.client.get(`access/members/${member.uid}`)).toEqual({ rev: 10 });
		expect(await code(member.client.get("presence"))).toBe("ok");
		expect(await code(member.client.get("access"))).toBe("denied");
		expect(await code(outsider.client.get("collections"))).toBe("denied");
		expect(await code(outsider.client.get(`access/members/${member.uid}`))).toBe("denied");
	});

	it("clients cannot publish, grant, extend, revoke or write anyone else's presence", async () => {
		await adapter.grant(member.uid, 11);
		const { client } = member;
		expect(await code(client.set("collections/policies", { revision: 99 }))).toBe("denied");
		expect(await code(client.set(`access/members/${member.uid}`, { rev: 99 }))).toBe("denied");
		expect(await code(client.set(`access/members/${outsider.uid}`, { rev: 99 }))).toBe("denied");
		expect(await code(client.set(`access/revoked/${member.uid}`, 1))).toBe("denied");
		expect(await code(client.set(`presence/${outsider.uid}`, { online: true, lastSeen: SERVER_TIMESTAMP }))).toBe(
			"denied",
		);
		expect(await code(client.set(`presence/${member.uid}`, { online: true, lastSeen: 1 }))).toBe("denied");
		expect(await code(client.set(`presence/${member.uid}`, { online: true, lastSeen: SERVER_TIMESTAMP }))).toBe("ok");
		expect(
			await code(outsider.client.set(`presence/${outsider.uid}`, { online: true, lastSeen: SERVER_TIMESTAMP })),
		).toBe("denied");
		// The member may only delete their own entry, and then loses access at once.
		expect(await code(client.delete(`access/members/${member.uid}`))).toBe("ok");
		expect(await code(client.get("collections"))).toBe("denied");
	});

	it("revisions never decrease, even when the dispatcher writes directly", async () => {
		await adapter.publish("claims", 5);
		await adapter.publish("claims", 4);
		expect(await owner.get("collections/claims")).toEqual({ revision: 5 });
		expect(await code(dispatcher.client.set("collections/claims", { revision: 2 }))).toBe("denied");
		expect(await code(dispatcher.client.set("collections/claims", { revision: 6, record: "x" }))).toBe("denied");
	});

	it("a grant older than a revocation is rejected, and revokeAll ends every grant", async () => {
		await adapter.grant(member.uid, 20);
		await adapter.revoke(member.uid, 21);
		expect(await code(member.client.get("collections"))).toBe("denied");
		expect(await owner.get(`presence/${member.uid}`)).toBeNull();
		// A membership check read before the removal arrives late: the rules reject it.
		expect(await code(adapter.grant(member.uid, 20))).toBe("denied");
		// An older, late revocation is a no-op; a newer membership is granted again.
		await adapter.revoke(member.uid, 19);
		await adapter.grant(member.uid, 22);
		await adapter.grant(outsider.uid, 22);
		expect(await code(member.client.get("collections"))).toBe("ok");

		await adapter.revokeAll(23);
		expect(await owner.get("access/members")).toBeNull();
		expect(await code(member.client.get("collections"))).toBe("denied");
		expect(await code(adapter.grant(member.uid, 23))).toBe("denied");
		expect(await code(adapter.grant(member.uid, 24))).toBe("ok");
	});
});
