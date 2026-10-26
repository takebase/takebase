import { AUTH_EMULATOR_URL, createClient, EMULATOR_URL } from "@takebase/firebase-rtdb";
import { createClient as createTakebase, type Fetch, type RealtimeEvent } from "@takebase/sdk";
import { deleteApp, type FirebaseApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { firebaseConnector } from "../src/client.ts";
import { databaseRules, firebaseRealtime } from "../src/index.ts";

// The browser connector with the real Firebase JS SDK and the Takebase SDK,
// against the Auth and Database emulators. Runs only inside `pnpm test:realtime`
// (firebase emulators:exec); otherwise skipped. The tenant Worker is a stand-in
// that grants through the real server adapter, so the rendered rules decide.

const running = Boolean(process.env.FIREBASE_DATABASE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
const namespace = `demo-takebase-client-${Date.now()}`;
const password = "local-only-password";
const tenantUrl = "http://localhost:8788";
const connection = { provider: "firebase", databaseURL: EMULATOR_URL, namespace };

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
	return { uid: localId, email };
};

const apps: FirebaseApp[] = [];

const signIn = async (email: string) => {
	const app = initializeApp({ apiKey: "demo-api-key", projectId: "demo-takebase" }, `${email}`);
	apps.push(app);
	const auth = getAuth(app);
	connectAuthEmulator(auth, AUTH_EMULATOR_URL, { disableWarnings: true });
	await signInWithEmailAndPassword(auth, email, password);
	return { app, auth };
};

const owner = createClient({ databaseURL: EMULATOR_URL, emulatorNamespace: namespace });

const loadRules = async (rules: object) => {
	const response = await fetch(`${EMULATOR_URL}/.settings/rules.json?ns=${namespace}`, {
		method: "PUT",
		headers: { authorization: "Bearer owner" },
		body: JSON.stringify(rules),
	});
	if (response.status !== 200) throw new Error(`rules should load: ${await response.text()}`);
};

const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 50 });

describe.skipIf(!running)("Firebase browser connector on the emulator", { timeout: 20_000 }, () => {
	let adapter: ReturnType<typeof firebaseRealtime>;
	let accessRevision = 1;

	beforeAll(async () => {
		const dispatcher = await signUp("dispatcher");
		await loadRules(databaseRules(dispatcher.uid));
		adapter = firebaseRealtime({
			databaseURL: EMULATOR_URL,
			apiKey: "demo-api-key",
			email: dispatcher.email,
			password,
			namespace,
		});
	});

	afterAll(async () => {
		await Promise.all(apps.map((app) => deleteApp(app)));
	});

	// A member signed in with Firebase, using the Takebase SDK against a tenant
	// stand-in: sessions grant at the current access revision while `member` holds.
	const memberClient = async () => {
		const user = await signUp("member");
		const { app, auth } = await signIn(user.email);
		const state = { member: true, sessions: 0 };
		const fetch: Fetch = async (url) => {
			if (url.endsWith("/api/tenants"))
				return Response.json({ tenants: [{ tenant: { id: "t1", name: "t1", url: tenantUrl }, roles: ["member"] }] });
			if (url === `${tenantUrl}/api/realtime/session`) {
				state.sessions++;
				if (!state.member) return Response.json({ error: { code: "forbidden", message: "x" } }, { status: 403 });
				await adapter.grant(user.uid, accessRevision);
				return Response.json({ uid: user.uid, revision: accessRevision, connection });
			}
			return new Response(null, { status: 404 });
		};
		const client = createTakebase({
			globalUrl: "http://localhost:8787",
			auth,
			fetch,
			realtime: { connector: firebaseConnector(app) },
		});
		await client.useTenant("t1");
		return { user, auth, client, state };
	};

	it("delivers revision signals, and a revocation signs the member out fully", async () => {
		const { user, auth, client, state } = await memberClient();
		const events: RealtimeEvent[] = [];
		const reasons: string[] = [];
		client.auth.onSignedOut((reason) => reasons.push(reason));
		client.collection("policies").subscribe("*", (event) => events.push(event));
		await waitFor(() => expect(events).toEqual([{ collection: "policies", revision: 0 }]));

		await adapter.publish("policies", 4);
		await waitFor(() => expect(events.at(-1)).toEqual({ collection: "policies", revision: 4 }));

		state.member = false;
		accessRevision++;
		await adapter.revoke(user.uid, accessRevision);
		await waitFor(() => expect(reasons).toEqual(["access_revoked"]));
		expect(auth.currentUser).toBeNull();
		expect(client.tenant()).toBeNull();
		expect(state.sessions).toBe(2);
	});

	it("removes the user's own grant when the connection closes (onDisconnect)", async () => {
		const { user, client } = await memberClient();
		const events: RealtimeEvent[] = [];
		const unsubscribe = client.collection("policies").subscribe("*", (event) => events.push(event));
		await waitFor(() => expect(events.length).toBeGreaterThan(0));
		expect(await owner.get(`access/members/${user.uid}`)).toEqual({ rev: accessRevision });

		unsubscribe();
		await waitFor(async () => expect(await owner.get(`access/members/${user.uid}`)).toBeNull());
	});

	it("a signed-in user without a grant reads no signals", async () => {
		const outsider = await signUp("outsider");
		const { app } = await signIn(outsider.email);
		await adapter.publish("policies", 5);
		let lost = 0;
		const revisions: number[] = [];
		const open = firebaseConnector(app)(
			{ uid: outsider.uid, revision: accessRevision, connection },
			{
				connected: () => {},
				lost: () => lost++,
			},
		);
		open.watch("policies", (revision) => revisions.push(revision));
		await waitFor(() => expect(lost).toBeGreaterThanOrEqual(2));
		expect(revisions).toEqual([]);
		open.close();
	});
});
