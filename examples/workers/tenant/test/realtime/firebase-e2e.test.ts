import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { databaseRules } from "@takebase/adapter-firebase";
import type { RealtimeSession } from "@takebase/contracts";
import type { MembershipCheck, MembershipVerifier } from "@takebase/core";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { json, newPolicy } from "../fixtures.ts";

// S-4-2-01 end to end: the deployed tenant Worker, its own Realtime Database
// namespace with the rendered rules, and real users from the Auth emulator.
// Runs only inside `pnpm test:realtime` (firebase emulators:exec); otherwise skipped.
// The global Worker is a stand-in answering per ID token.

const running = env.TEST_FIREBASE_EMULATORS === "1";
const authEmulator = "http://127.0.0.1:9099";
const databaseEmulator = "http://127.0.0.1:9000";
const namespace = `demo-takebase-${env.TENANT_ID}-${Date.now()}`;
const password = "local-only-password";

type User = { uid: string; email: string; token: string };

const signUp = async (name: string): Promise<User> => {
	const email = `${name}-${env.TENANT_ID}-${Date.now()}@example.test`;
	const response = await fetch(`${authEmulator}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password, returnSecureToken: true }),
	});
	expect(response.status).toBe(200);
	const { localId, idToken } = (await response.json()) as { localId: string; idToken: string };
	return { uid: localId, email, token: idToken };
};

// What a browser holding this user's ID token can read straight from RTDB.
const read = async (user: User, path: string) => {
	const response = await fetch(`${databaseEmulator}/${path}.json?ns=${namespace}&auth=${user.token}`);
	return { status: response.status, body: response.status === 200 ? await response.json() : null };
};

const answers = new Map<string, MembershipCheck>();
const global: MembershipVerifier = {
	verifyMembership: async (token) => answers.get(token) ?? { status: "invalid_token" },
};

describe.skipIf(!running)("realtime through the tenant Worker and the emulators (S-4-2-01)", () => {
	let dispatcher: User;
	let member: User;
	let outsider: User;

	const send = async (user: User, method: string, path: string, body?: unknown) => {
		const execution = createExecutionContext();
		const init = body === undefined ? { method } : json(method, body);
		const request = new Request(`https://tenant.local${path}`, {
			...init,
			headers: { ...init.headers, authorization: `Bearer ${user.token}` },
		});
		const response = await app.fetch(
			request,
			{
				...env,
				GLOBAL: global,
				FIREBASE_DATABASE_NAMESPACE: namespace,
				FIREBASE_DISPATCHER_EMAIL: dispatcher.email,
				FIREBASE_DISPATCHER_PASSWORD: password,
			},
			execution,
		);
		await waitOnExecutionContext(execution);
		return response;
	};

	beforeAll(async () => {
		[dispatcher, member, outsider] = await Promise.all([signUp("dispatcher"), signUp("member"), signUp("outsider")]);
		const rules = await fetch(`${databaseEmulator}/.settings/rules.json?ns=${namespace}`, {
			method: "PUT",
			headers: { authorization: "Bearer owner" },
			body: JSON.stringify(databaseRules(dispatcher.uid)),
		});
		expect(rules.status).toBe(200);
		answers.set(member.token, {
			status: "member",
			identity: { id: member.uid, provider: "firebase", roles: ["member", "agent"] },
			revision: 7,
		});
		answers.set(outsider.token, { status: "not_member", subject: outsider.uid, revision: 7 });
		answers.set(dispatcher.token, { status: "not_member", subject: dispatcher.uid, revision: 7 });
	});

	it("a member's session sees committed revisions; outsiders and the dispatcher get nothing", async () => {
		expect((await read(member, "collections")).status).toBe(401);
		const session = await send(member, "POST", "/api/realtime/session");
		expect(session.status).toBe(200);
		expect(await session.json()).toEqual({
			uid: member.uid,
			revision: 7,
			connection: { provider: "firebase", databaseURL: databaseEmulator, namespace },
		} satisfies RealtimeSession);

		expect((await send(member, "POST", "/api/collections/policies/records", newPolicy())).status).toBe(201);
		const signals = await read(member, "collections");
		expect(signals.status).toBe(200);
		expect(signals.body).toEqual({ policies: { revision: expect.any(Number) } });

		expect((await send(outsider, "POST", "/api/realtime/session")).status).toBe(403);
		expect((await read(outsider, "collections")).status).toBe(401);
		// The dispatcher account is no tenant member: it cannot use the tenant API.
		expect((await send(dispatcher, "GET", "/api/collections/policies/records")).status).toBe(403);
	});

	it("a not_member answer revokes the member's realtime access at once", async () => {
		expect((await send(member, "POST", "/api/realtime/session")).status).toBe(200);
		expect((await read(member, "collections")).status).toBe(200);

		answers.set(member.token, { status: "not_member", subject: member.uid, revision: 8 });
		expect((await send(member, "GET", "/api/collections/policies/records")).status).toBe(403);
		expect((await read(member, "collections")).status).toBe(401);
		expect((await read(member, `access/members/${member.uid}`)).body).toBeNull();
	});
});
