import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { AUTH_EMULATOR_URL, createClient, EMULATOR_URL, FirebaseRtdbError } from "../src/index.ts";

// Against the real Auth and Realtime Database emulators. Runs only inside
// `firebase emulators:exec --only auth,database --project demo-takebase`, which
// sets the emulator hosts; otherwise skipped. The repository's database rules
// deny everything, so a signed-in user is denied while the admin owner is not.

const running = Boolean(process.env.FIREBASE_DATABASE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
const namespace = "demo-takebase-default-rtdb";
const path = `firebase-rtdb-test/${Date.now()}`;

const signUp = async (email: string, password: string) => {
	const response = await fetch(
		`${AUTH_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password, returnSecureToken: true }),
		},
	);
	assert.equal(response.status, 200, "the Auth emulator should create the user");
};

const code = async (promise: Promise<unknown>) => {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	return error instanceof FirebaseRtdbError ? error.code : String(error);
};

describe.skipIf(!running)("Firebase emulators", () => {
	test("a conditional write succeeds once and then conflicts", async () => {
		const owner = createClient({ databaseURL: EMULATOR_URL, emulatorNamespace: namespace });
		await owner.set(path, { revision: 1 });
		const { value, etag } = await owner.getWithETag(path);
		assert.deepEqual(value, { revision: 1 });
		await owner.setIfUnchanged(path, { revision: 2 }, etag);
		assert.equal(await code(owner.setIfUnchanged(path, { revision: 3 }, etag)), "conflict");
		assert.deepEqual(await owner.get(path), { revision: 2 });
		await owner.delete(path);
	});

	test("a user signed in through the Auth emulator is bound by the database rules", async () => {
		const email = `rtdb-${Date.now()}@example.com`;
		const password = "local-test-password";
		await signUp(email, password);
		const user = createClient({
			databaseURL: EMULATOR_URL,
			authEmulatorURL: AUTH_EMULATOR_URL,
			emulatorNamespace: namespace,
			email,
			password,
		});
		assert.equal(await code(user.get(path)), "denied");
		assert.equal(await code(user.set(path, { revision: 1 })), "denied");
	});
});
