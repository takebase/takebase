// Wave 4-2 section A (SEGU-216): the Realtime Database emulator capabilities the
// realtime design relies on. Each test probes one capability in its own
// namespace, loading rules at runtime. Run inside the emulators:
//   firebase emulators:exec --only auth,database --project demo-takebase 'node --test tests/firebase/rtdb-capabilities.test.ts'

import assert from "node:assert/strict";
import { test } from "node:test";

const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const databaseHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? "127.0.0.1:9000";
const run = Date.now();

const url = (namespace: string, path: string, idToken?: string) => {
	const target = new URL(`http://${databaseHost}/${path}.json`);
	target.searchParams.set("ns", namespace);
	if (idToken) target.searchParams.set("auth", idToken);
	return target;
};

const owner = { authorization: "Bearer owner" };

// Loads rules into one namespace at runtime, as the 4-2 tests will for rules
// rendered with an emulator-generated dispatcher uid.
const setRules = async (namespace: string, rules: object) => {
	const response = await fetch(url(namespace, ".settings/rules"), {
		method: "PUT",
		headers: owner,
		body: JSON.stringify({ rules }),
	});
	assert.equal(response.status, 200, `rules should load into ${namespace}: ${await response.text()}`);
};

const asOwner = (namespace: string, method: string, path: string, body?: unknown) =>
	fetch(url(namespace, path), { method, headers: owner, body: body === undefined ? undefined : JSON.stringify(body) });

const asUser = (namespace: string, token: string, method: string, path: string, body?: unknown) =>
	fetch(url(namespace, path, token), { method, body: body === undefined ? undefined : JSON.stringify(body) });

const signUp = async () => {
	const response = await fetch(
		`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ returnSecureToken: true }),
		},
	);
	assert.equal(response.status, 200);
	const { idToken, localId } = (await response.json()) as { idToken: string; localId: string };
	return { token: idToken, uid: localId };
};

const memberRead = "auth != null && root.child('members').child(auth.uid).exists()";

test("rules load per namespace at runtime and apply only there", async () => {
	const open = `caps-open-${run}`;
	const closed = `caps-closed-${run}`;
	await setRules(open, { ".read": "auth != null", ".write": false });
	await setRules(closed, { ".read": false, ".write": false });
	const { token } = await signUp();
	assert.equal((await asUser(open, token, "GET", "x")).status, 200);
	assert.equal((await asUser(closed, token, "GET", "x")).status, 401);
});

test("rules can read other paths (root.child) to decide access", async () => {
	const ns = `caps-root-${run}`;
	await setRules(ns, { ".read": false, ".write": false, collections: { ".read": memberRead } });
	const { token, uid } = await signUp();
	assert.equal((await asUser(ns, token, "GET", "collections")).status, 401);
	assert.equal((await asOwner(ns, "PUT", `members/${uid}`, { rev: 1 })).status, 200);
	assert.equal((await asUser(ns, token, "GET", "collections")).status, 200);
});

test("a versioned grant older than the revocation is rejected, and revocation is one atomic update", async () => {
	const ns = `caps-versioned-${run}`;
	const dispatcher = await signUp();
	const member = await signUp();
	const isDispatcher = `auth != null && auth.uid === '${dispatcher.uid}'`;
	await setRules(ns, {
		".read": false,
		".write": false,
		members: {
			$uid: {
				".write": `${isDispatcher} || (auth != null && auth.uid === $uid && !newData.exists())`,
				".validate": `newData.child('rev').isNumber() && (!root.child('revoked').child($uid).exists() || newData.child('rev').val() > root.child('revoked').child($uid).val())`,
			},
		},
		revoked: { $uid: { ".write": isDispatcher, ".validate": "newData.isNumber()" } },
	});
	const grant = (rev: number) => asUser(ns, dispatcher.token, "PUT", `members/${member.uid}`, { rev });

	assert.equal((await grant(57)).status, 200);
	// Revocation: delete the grant and record the revision in one multi-path update.
	const revoke = await asUser(ns, dispatcher.token, "PATCH", "", {
		[`members/${member.uid}`]: null,
		[`revoked/${member.uid}`]: 58,
	});
	assert.equal(revoke.status, 200);
	assert.equal(await (await asOwner(ns, "GET", `members/${member.uid}`)).json(), null);
	// The stale grant from a membership check made before the removal loses.
	assert.equal((await grant(57)).status, 401);
	assert.equal(await (await asOwner(ns, "GET", `members/${member.uid}`)).json(), null);
	// A newer membership (re-added user) is granted again.
	assert.equal((await grant(59)).status, 200);
	// The member can delete their own entry but never create or extend it.
	assert.equal((await asUser(ns, member.token, "PUT", `members/${member.uid}`, { rev: 99 })).status, 401);
	assert.equal((await asUser(ns, member.token, "DELETE", `members/${member.uid}`)).status, 200);
});

test("presence accepts only the owner's server-timestamped entry while they are a member", async () => {
	const ns = `caps-presence-${run}`;
	const { token, uid } = await signUp();
	await setRules(ns, {
		".read": false,
		".write": false,
		presence: {
			$uid: {
				".write": "auth != null && auth.uid === $uid && root.child('members').child(auth.uid).exists()",
				".validate":
					"newData.hasChildren(['online', 'lastSeen']) && newData.child('online').isBoolean() && newData.child('lastSeen').val() === now",
				online: { ".validate": true },
				lastSeen: { ".validate": true },
				$other: { ".validate": false },
			},
		},
	});
	const presence = (body: unknown) => asUser(ns, token, "PUT", `presence/${uid}`, body);
	const now = { online: true, lastSeen: { ".sv": "timestamp" } };
	assert.equal((await presence(now)).status, 401, "not a member yet");
	await asOwner(ns, "PUT", `members/${uid}`, { rev: 1 });
	assert.equal((await presence(now)).status, 200);
	assert.equal((await presence({ online: true, lastSeen: 1 })).status, 401, "client-chosen time");
	assert.equal((await presence({ ...now, extra: 1 })).status, 401, "extra field");
});

test("an open stream is cancelled when the reader loses access", async () => {
	const ns = `caps-stream-${run}`;
	await setRules(ns, { ".read": false, ".write": false, collections: { ".read": memberRead } });
	const { token, uid } = await signUp();
	await asOwner(ns, "PUT", `members/${uid}`, { rev: 1 });
	await asOwner(ns, "PUT", "collections/policies", { revision: 1 });

	const controller = new AbortController();
	const stream = await fetch(url(ns, "collections", token), {
		headers: { accept: "text/event-stream" },
		signal: controller.signal,
	});
	assert.equal(stream.status, 200);
	const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let received = "";
	const waitFor = async (event: string) => {
		const deadline = Date.now() + 5000;
		while (!received.includes(`event: ${event}`)) {
			if (Date.now() > deadline) throw new Error(`no "${event}" event; got: ${received}`);
			const { value, done } = await reader.read();
			if (done) throw new Error(`stream ended before "${event}"`);
			received += decoder.decode(value, { stream: true });
		}
	};
	try {
		await waitFor("put");
		await asOwner(ns, "DELETE", `members/${uid}`);
		await waitFor("cancel");
	} finally {
		controller.abort();
	}
});
