import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "vitest";

import {
	createClient,
	DEFAULT_EMULATOR_NAMESPACE,
	EMULATOR_URL,
	FirebaseRtdbError,
	isValidKey,
	SERVER_TIMESTAMP,
} from "../src/index.ts";
import { at, empty, hang, json, live, refreshed, scriptedFetch, signIn } from "./helpers.ts";

const rejectsWith = (promise: Promise<unknown>, code: string) =>
	assert.rejects(promise, (error: unknown) => error instanceof FirebaseRtdbError && error.code === code);

test("rejects database URLs that are not a Firebase origin or the emulator", () => {
	const bad = [
		"",
		"http://demo.firebaseio.com",
		"https://example.com",
		"https://firebaseio.com",
		"https://demo.firebaseio.com/otp",
		"https://demo.firebaseio.com?ns=x",
		"https://demo.firebaseio.com#x",
		"https://demo.firebaseio.com:443",
		"https://user:pw@demo.firebaseio.com",
		" https://demo.firebaseio.com",
		"http://localhost:9000",
		"http://127.0.0.1:9001",
	];
	for (const databaseURL of bad) {
		assert.throws(() => createClient({ ...live, databaseURL }), { code: "invalid_options" }, databaseURL);
	}
	assert.equal(createClient({ ...live, databaseURL: "https://demo.firebaseio.com/" }).mode, "live");
	assert.equal(createClient({ ...live, databaseURL: "https://x.europe-west1.firebasedatabase.app" }).mode, "live");
});

test("requires all three credentials for a live database", () => {
	for (const missing of ["apiKey", "email", "password"] as const) {
		assert.throws(() => createClient({ ...live, [missing]: "" }), { code: "invalid_options" });
	}
	assert.throws(() => createClient({ ...live, password: "a\nb" }), { code: "invalid_options" });
});

test("emulator requests use the namespace and owner bearer, never credentials", async () => {
	const { fetch, calls } = scriptedFetch(() => json({ a: 1 }));
	const client = createClient({ databaseURL: `${EMULATOR_URL}/`, apiKey: "ignored", fetch });
	assert.equal(client.mode, "emulator");
	assert.deepEqual(await client.get("otp/abc"), { a: 1 });
	const call = at(calls, 0);
	assert.equal(call.url.origin, EMULATOR_URL);
	assert.equal(call.url.pathname, "/otp/abc.json");
	assert.equal(call.url.searchParams.get("ns"), DEFAULT_EMULATOR_NAMESPACE);
	assert.equal(call.url.searchParams.has("auth"), false);
	assert.equal((call.init.headers as Record<string, string>).Authorization, "Bearer owner");
});

test("signs in once and reuses the token, including for concurrent requests", async () => {
	const { fetch, calls } = scriptedFetch(
		signIn(),
		() => json(1),
		() => json(2),
		() => json(3),
	);
	const client = createClient({ ...live, fetch });
	assert.deepEqual(await Promise.all([client.get("a"), client.get("b")]), [1, 2]);
	assert.equal(await client.get("c"), 3);
	const [auth, reads] = [at(calls, 0), calls.slice(1)];
	assert.equal(
		auth.url.origin + auth.url.pathname,
		"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
	);
	assert.equal(auth.url.searchParams.get("key"), live.apiKey);
	assert.deepEqual(JSON.parse(auth.init.body as string), {
		email: live.email,
		password: live.password,
		returnSecureToken: true,
	});
	for (const read of reads) {
		assert.equal(read.url.origin, live.databaseURL);
		assert.equal(read.url.searchParams.get("auth"), "id-token-1");
		assert.equal(read.init.redirect, "manual");
	}
});

test("refreshes with the refresh token once the ID token is near expiry", async () => {
	// expiresIn of 31 seconds is inside the 30-second margin after one second passes.
	const { fetch, calls } = scriptedFetch(
		signIn("id-token-1", "31"),
		() => json(1),
		refreshed(),
		() => json(2),
	);
	const client = createClient({ ...live, fetch });
	await client.get("a");
	await new Promise((resolve) => setTimeout(resolve, 1100));
	await client.get("b");
	const refresh = at(calls, 2);
	assert.equal(refresh.url.origin + refresh.url.pathname, "https://securetoken.googleapis.com/v1/token");
	const form = new URLSearchParams(refresh.init.body as string);
	assert.equal(form.get("grant_type"), "refresh_token");
	assert.equal(form.get("refresh_token"), "refresh-1");
	assert.equal(String(refresh.init.body).includes(live.password), false);
	assert.equal(at(calls, 3).url.searchParams.get("auth"), "id-token-2");
});

test("maps sign-in failures to rejected or unavailable", async () => {
	for (const [status, code] of [
		[400, "auth_rejected"],
		[403, "auth_rejected"],
		[429, "auth_unavailable"],
		[503, "auth_unavailable"],
	] as const) {
		const { fetch } = scriptedFetch(() => json({ error: "x" }, status));
		await rejectsWith(createClient({ ...live, fetch }).get("a"), code);
	}
	const network = scriptedFetch(() => Promise.reject(new TypeError("fetch failed")));
	await rejectsWith(createClient({ ...live, fetch: network.fetch }).get("a"), "auth_unavailable");
	for (const bad of [
		{},
		{ idToken: "t", refreshToken: "r", expiresIn: 3600 },
		{ idToken: "t", refreshToken: "r", expiresIn: "10" },
	]) {
		const { fetch } = scriptedFetch(() => json(bad));
		await rejectsWith(createClient({ ...live, fetch }).get("a"), "auth_unavailable");
	}
});

test("a rejected sign-in is retried on the next request", async () => {
	const { fetch } = scriptedFetch(
		() => json({}, 400),
		signIn(),
		() => json("ok"),
	);
	const client = createClient({ ...live, fetch });
	await rejectsWith(client.get("a"), "auth_rejected");
	assert.equal(await client.get("a"), "ok");
});

test("set, update and delete use print=silent and expect 204", async () => {
	const { fetch, calls } = scriptedFetch(
		signIn(),
		() => empty(),
		() => empty(),
		() => empty(),
		() => json(null, 200),
	);
	const client = createClient({ ...live, fetch });
	await client.set("a/b", { at: SERVER_TIMESTAMP });
	await client.update("a/b", { "c/d": 1 });
	await client.delete("a/b");
	await rejectsWith(client.set("a/b", 1), "request_failed");
	const [put, patch, del] = [at(calls, 1), at(calls, 2), at(calls, 3)];
	assert.equal(put.init.method, "PUT");
	assert.equal(put.init.body, '{"at":{".sv":"timestamp"}}');
	assert.equal((put.init.headers as Record<string, string>)["Content-Type"], "application/json");
	assert.equal(patch.init.method, "PATCH");
	assert.equal(del.init.method, "DELETE");
	assert.equal(del.init.body, undefined);
	for (const call of [put, patch, del]) assert.equal(call.url.searchParams.get("print"), "silent");
});

test("push returns the generated key and validates it", async () => {
	const { fetch, calls } = scriptedFetch(
		signIn(),
		() => json({ name: "-NabcDEF123" }),
		() => json({ name: "a/b" }),
		() => json({}),
	);
	const client = createClient({ ...live, fetch });
	assert.equal(await client.push("otp/abc", { v: "1" }), "-NabcDEF123");
	assert.equal(at(calls, 1).init.method, "POST");
	assert.equal(at(calls, 1).url.searchParams.has("print"), false);
	await rejectsWith(client.push("otp/abc", 1), "invalid_response");
	await rejectsWith(client.push("otp/abc", 1), "invalid_response");
});

test("validates paths and values before any request", async () => {
	const { fetch, calls } = scriptedFetch();
	const client = createClient({ ...live, fetch });
	for (const path of ["", "/", "a//b", "a/.b", "a#b", "a$b", "a[b", "x\u0001", "\uD800", "k".repeat(769)]) {
		await rejectsWith(client.get(path), "invalid_path");
	}
	await rejectsWith(client.set("a", undefined), "invalid_value");
	await rejectsWith(client.set("a", 1n), "invalid_value");
	await rejectsWith(client.update("a", [] as never), "invalid_value");
	assert.equal(calls.length, 0);
	assert.equal(isValidKey("é".repeat(384)), true);
	assert.equal(isValidKey("é".repeat(385)), false);
});

test("trims surrounding slashes and percent-encodes keys", async () => {
	const { fetch, calls } = scriptedFetch(() => json(null));
	await createClient({ databaseURL: EMULATOR_URL, fetch }).get("/otp/a b%/");
	assert.equal(at(calls, 0).url.pathname, "/otp/a%20b%25.json");
});

test("denied responses invalidate the token so the next request refreshes", async () => {
	const { fetch, calls } = scriptedFetch(
		signIn(),
		() => json({ error: "Permission denied" }, 401),
		refreshed(),
		() => json(1),
	);
	const client = createClient({ ...live, fetch });
	await rejectsWith(client.get("a"), "denied");
	assert.equal(await client.get("a"), 1);
	assert.equal(at(calls, 2).url.hostname, "securetoken.googleapis.com");
});

test("redirects, oversized and malformed bodies fail without following or parsing", async () => {
	const { fetch } = scriptedFetch(
		() => new Response(null, { status: 307, headers: { Location: "https://evil.example/" } }),
		() => json("x".repeat(100)),
		() => new Response("{not json", { status: 200 }),
		() => new Response(new Uint8Array([0x22, 0xff, 0x22]), { status: 200 }),
	);
	const client = createClient({ databaseURL: EMULATOR_URL, maxResponseBytes: 50, fetch });
	await rejectsWith(client.get("a"), "request_failed");
	await rejectsWith(client.get("a"), "invalid_response");
	await rejectsWith(client.get("a"), "invalid_response");
	await rejectsWith(client.get("a"), "invalid_response");
});

test("distinguishes timeout, caller abort and connection failure", async () => {
	const timeout = scriptedFetch(hang);
	await rejectsWith(
		createClient({ databaseURL: EMULATOR_URL, timeoutMs: 20, fetch: timeout.fetch }).get("a"),
		"timeout",
	);

	const aborted = scriptedFetch(hang);
	const controller = new AbortController();
	const pending = createClient({ databaseURL: EMULATOR_URL, fetch: aborted.fetch }).get("a", {
		signal: controller.signal,
	});
	controller.abort();
	await rejectsWith(pending, "aborted");

	const broken = scriptedFetch(() => Promise.reject(new TypeError("fetch failed")));
	await rejectsWith(createClient({ databaseURL: EMULATOR_URL, fetch: broken.fetch }).get("a"), "connection_failed");
});

test("the deadline also covers a stalled body and a fetch that ignores its signal", async () => {
	const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
	const body = scriptedFetch(() => new Response(stalled, { status: 200 }));
	await rejectsWith(createClient({ databaseURL: EMULATOR_URL, timeoutMs: 20, fetch: body.fetch }).get("a"), "timeout");

	const deaf = scriptedFetch(() => new Promise<Response>(() => {}));
	await rejectsWith(createClient({ databaseURL: EMULATOR_URL, timeoutMs: 20, fetch: deaf.fetch }).get("a"), "timeout");
});

test("a caller abort while waiting for sign-in does not cancel the shared sign-in", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const { fetch } = scriptedFetch(
		async () => {
			await gate;
			return signIn();
		},
		() => json("second"),
	);
	const client = createClient({ ...live, fetch });
	const controller = new AbortController();
	const first = client.get("a", { signal: controller.signal });
	const second = client.get("b");
	controller.abort();
	await rejectsWith(first, "aborted");
	release();
	assert.equal(await second, "second");
});

test("errors never include URLs, tokens or credentials", async () => {
	const { fetch } = scriptedFetch(signIn("secret-id-token"), () => json({ error: "detail" }, 500));
	const error = await createClient({ ...live, fetch })
		.get("otp/abc")
		.catch((e: unknown) => e);
	assert.ok(error instanceof FirebaseRtdbError);
	const text = `${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`;
	for (const secret of ["secret-id-token", live.password, live.apiKey, live.databaseURL, "otp/abc", "detail"]) {
		assert.equal(text.includes(secret), false, secret);
	}
});

test("the client object is frozen and dumps no credentials or tokens", async () => {
	const { fetch } = scriptedFetch(signIn("secret-id-token"), () => json(1));
	const client = createClient({ ...live, fetch });
	await client.get("a");
	const dumps = [
		inspect(client, { depth: 10, showHidden: true }),
		JSON.stringify(client),
		JSON.stringify({ ...client }),
	];
	for (const dump of dumps) {
		for (const secret of ["secret-id-token", "refresh-1", live.password, live.apiKey, live.email]) {
			assert.equal(dump.includes(secret), false, secret);
		}
	}
	assert.equal(Object.isFrozen(client), true);
	assert.throws(() => {
		(client as { get: unknown }).get = () => {};
	}, TypeError);
});

test("close forgets credentials and fails later calls", async () => {
	const { fetch, calls } = scriptedFetch();
	const client = createClient({ ...live, fetch });
	client.close();
	await rejectsWith(client.get("a"), "closed");
	assert.equal(calls.length, 0);
});
