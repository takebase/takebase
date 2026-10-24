import assert from "node:assert/strict";
import { test } from "vitest";
import { AUTH_EMULATOR_URL, createClient, EMULATOR_URL, FirebaseRtdbError, isRetryable } from "../src/index.ts";
import { at, hang, json, live, scriptedFetch, signIn } from "./helpers.ts";

// Behavior Takebase added to the segufirebase 0.0.2 copy (SEGU-240).

const failure = async (promise: Promise<unknown>) => {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	assert.ok(error instanceof FirebaseRtdbError, "expected a FirebaseRtdbError");
	return error;
};

const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

const withETag = (value: unknown, etag: string, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ETag: etag } });

test("getWithETag asks for the ETag and returns it with the value", async () => {
	const { fetch, calls } = scriptedFetch(withETag({ revision: 7 }, "etag-1"), () => json({ revision: 7 }));
	const client = createClient({ databaseURL: EMULATOR_URL, fetch });
	assert.deepEqual(await client.getWithETag("collections/policies"), { value: { revision: 7 }, etag: "etag-1" });
	assert.equal(header(at(calls, 0).init, "X-Firebase-ETag"), "true");
	// A response without an ETag cannot back a conditional write.
	assert.equal((await failure(client.getWithETag("collections/policies"))).code, "invalid_response");
});

test("setIfUnchanged sends if-match, and a changed value fails with conflict", async () => {
	const { fetch, calls } = scriptedFetch(
		() => json({ revision: 8 }),
		() => json({ error: "ETag mismatch" }, 412),
	);
	const client = createClient({ databaseURL: EMULATOR_URL, fetch });
	await client.setIfUnchanged("collections/policies", { revision: 8 }, "etag-1");
	const write = at(calls, 0);
	assert.equal(write.init.method, "PUT");
	assert.equal(header(write.init, "if-match"), "etag-1");
	assert.equal(write.url.searchParams.has("print"), false);

	const conflict = await failure(client.setIfUnchanged("collections/policies", { revision: 8 }, "etag-1"));
	assert.equal(conflict.code, "conflict");
	assert.equal(isRetryable(conflict), false);

	for (const etag of ["", "a\r\nb"]) {
		assert.equal((await failure(client.setIfUnchanged("x", 1, etag))).code, "invalid_value");
	}
	assert.equal(calls.length, 2);
});

test("throttling and server errors are retryable; other failures are not", async () => {
	const statuses = [408, 429, 500, 503, 400, 404];
	const { fetch } = scriptedFetch(...statuses.map((status) => () => json({ error: "x" }, status)), hang, () =>
		Promise.reject(new TypeError("fetch failed")),
	);
	const client = createClient({ databaseURL: EMULATOR_URL, timeoutMs: 20, fetch });
	const codes: string[] = [];
	const retryable: boolean[] = [];
	for (let i = 0; i < statuses.length + 2; i++) {
		const error = await failure(client.get("a"));
		codes.push(error.code);
		retryable.push(isRetryable(error));
	}
	assert.deepEqual(codes, [
		"unavailable",
		"unavailable",
		"unavailable",
		"unavailable",
		"request_failed",
		"request_failed",
		"timeout",
		"connection_failed",
	]);
	assert.deepEqual(retryable, [true, true, true, true, false, false, true, true]);
	assert.equal(isRetryable(new Error("not ours")), false);
});

test("the emulator signs in as a real user through the Auth emulator, so rules apply", async () => {
	const { fetch, calls } = scriptedFetch(signIn("user-token"), () => json(1));
	const client = createClient({
		databaseURL: EMULATOR_URL,
		authEmulatorURL: AUTH_EMULATOR_URL,
		emulatorNamespace: "demo-takebase-tenant-a",
		email: live.email,
		password: live.password,
		fetch,
	});
	assert.equal(client.mode, "emulator");
	assert.equal(await client.get("a"), 1);
	const signInCall = at(calls, 0);
	assert.equal(
		signInCall.url.origin + signInCall.url.pathname,
		`${AUTH_EMULATOR_URL}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`,
	);
	const read = at(calls, 1);
	assert.equal(read.url.searchParams.get("auth"), "user-token");
	assert.equal(read.url.searchParams.get("ns"), "demo-takebase-tenant-a");
	assert.equal(header(read.init, "Authorization"), undefined);
});

test("the Auth emulator is accepted only at its fixed local URL, with the database emulator", () => {
	const user = { email: live.email, password: live.password };
	for (const authEmulatorURL of ["http://localhost:9099", "http://127.0.0.1:9098", "https://127.0.0.1:9099"]) {
		assert.throws(() => createClient({ databaseURL: EMULATOR_URL, authEmulatorURL, ...user }), {
			code: "invalid_options",
		});
	}
	assert.throws(() => createClient({ databaseURL: EMULATOR_URL, authEmulatorURL: AUTH_EMULATOR_URL }), {
		code: "invalid_options",
	});
	assert.throws(() => createClient({ ...live, authEmulatorURL: AUTH_EMULATOR_URL }), { code: "invalid_options" });
});
