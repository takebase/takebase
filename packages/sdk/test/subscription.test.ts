import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createClient,
	type Fetch,
	type RealtimeConnector,
	type RealtimeEvent,
	type RealtimeEvents,
	type RealtimeSession,
} from "../src/index.ts";
import { fakeAuth, globalUrl, membership, withDiscovery } from "./helpers.ts";

// A stand-in connector: tests push revisions and connection events into the
// open connections and check which listeners are still attached.
const fakeConnector = () => {
	type Connection = {
		session: RealtimeSession;
		events: RealtimeEvents;
		watching: Map<string, (revision: number) => void>;
		closed: boolean;
	};
	const connections: Connection[] = [];
	const revisions = new Map<string, number>();
	const connector: RealtimeConnector = (session, events) => {
		const connection: Connection = { session, events, watching: new Map(), closed: false };
		connections.push(connection);
		return {
			watch: (collection, next) => {
				connection.watching.set(collection, next);
				next(revisions.get(collection) ?? 0);
				return () => connection.watching.delete(collection);
			},
			close: () => {
				connection.closed = true;
				connection.watching.clear();
			},
		};
	};
	const open = () => connections.filter(({ closed }) => !closed);
	const publish = (collection: string, revision: number) => {
		revisions.set(collection, revision);
		for (const connection of open()) connection.watching.get(collection)?.(revision);
	};
	return { connector, connections, open, publish };
};

// The tenant answers sessions with `sessionStatus` (200 grants) and counts them.
const setup = async (tenants = [membership("t1", "https://t1.example"), membership("t2", "https://t2.example")]) => {
	const realtime = fakeConnector();
	const state = { sessionStatus: 200, sessions: [] as string[] };
	const fetch: Fetch = async (url) => {
		if (url.endsWith("/api/realtime/session")) {
			state.sessions.push(url);
			return state.sessionStatus === 200
				? Response.json({ uid: "user-1", revision: 7, connection: { provider: "fake" } })
				: Response.json({ error: { code: "forbidden", message: "Not a member" } }, { status: state.sessionStatus });
		}
		return Response.json({ items: [], page: 1, perPage: 20, totalItems: 0, totalPages: 0 });
	};
	const { auth, signIn } = fakeAuth();
	const signOut = vi.spyOn(auth, "signOut");
	const client = createClient({
		globalUrl,
		auth,
		fetch: withDiscovery(tenants, fetch),
		realtime: { connector: realtime.connector, coalesceMs: 50 },
	});
	await client.useTenant("t1");
	const events: RealtimeEvent[] = [];
	const listen = (name = "policies") => client.collection(name).subscribe("*", (event) => events.push(event));
	return { client, realtime, state, events, listen, signOut, signIn };
};

const settle = () => vi.advanceTimersByTimeAsync(60);

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("SDK realtime subscriptions", () => {
	it("opens one session lazily, catches up on subscribe and closes after the last unsubscribe", async () => {
		const { realtime, state, events, listen } = await setup();
		realtime.publish("policies", 3);

		const first = listen();
		const second = listen("claims");
		await settle();
		expect(state.sessions).toEqual(["https://t1.example/api/realtime/session"]);
		expect(realtime.open()).toHaveLength(1);
		expect(events).toEqual([
			{ collection: "policies", revision: 3 },
			{ collection: "claims", revision: 0 },
		]);

		first();
		first();
		realtime.publish("policies", 4);
		await settle();
		expect(events).toHaveLength(2);
		expect(realtime.open()).toHaveLength(1);

		second();
		expect(realtime.open()).toHaveLength(0);
	});

	it("coalesces bursts and drops repeated or older revisions", async () => {
		const { realtime, events, listen } = await setup();
		listen();
		await settle();
		events.length = 0;

		realtime.publish("policies", 5);
		realtime.publish("policies", 6);
		realtime.publish("policies", 6);
		await settle();
		realtime.publish("policies", 4);
		realtime.publish("policies", 6);
		await settle();
		expect(events).toEqual([{ collection: "policies", revision: 6 }]);
	});

	it("opens a new session after a reconnect and catches up even without a newer revision", async () => {
		const { realtime, state, events, listen } = await setup();
		listen();
		await settle();
		events.length = 0;

		const [connection] = realtime.connections;
		// The first "offline" comes before the connection was ever up: not a reconnect.
		connection?.events.connected(false);
		connection?.events.connected(true);
		await settle();
		expect(state.sessions).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(5_000);
		connection?.events.connected(false);
		connection?.events.connected(true);
		await settle();
		expect(state.sessions).toHaveLength(2);
		expect(connection?.closed).toBe(true);
		expect(realtime.open()).toHaveLength(1);
		expect(events).toEqual([{ collection: "policies", revision: 0 }]);
	});

	it("re-attaches when the API still accepts the user after an access loss", async () => {
		const { client, realtime, state, listen, signOut } = await setup();
		listen();
		await vi.advanceTimersByTimeAsync(5_000);

		realtime.connections[0]?.events.lost();
		await settle();
		expect(state.sessions).toHaveLength(2);
		expect(realtime.open()).toHaveLength(1);
		expect(signOut).not.toHaveBeenCalled();
		expect(client.tenant()?.tenant.id).toBe("t1");
	});

	it("backs off when access is lost right after connecting, so a grant race cannot loop", async () => {
		const { realtime, state, listen } = await setup();
		listen();
		await settle();

		realtime.connections[0]?.events.lost();
		await settle();
		expect(state.sessions).toHaveLength(1);
		expect(realtime.open()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(state.sessions).toHaveLength(2);

		realtime.connections[1]?.events.lost();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(state.sessions).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(state.sessions).toHaveLength(3);
		expect(realtime.open()).toHaveLength(1);
	});

	it("signs out fully when the API confirms the access loss", async () => {
		const { client, realtime, state, events, listen, signOut } = await setup();
		const reasons: string[] = [];
		client.auth.onSignedOut((reason) => reasons.push(reason));
		listen();
		await settle();
		events.length = 0;

		state.sessionStatus = 403;
		await vi.advanceTimersByTimeAsync(5_000);
		realtime.connections[0]?.events.lost();
		await settle();
		expect(signOut).toHaveBeenCalledOnce();
		expect(reasons).toEqual(["access_revoked"]);
		expect(client.tenant()).toBeNull();
		expect(realtime.open()).toHaveLength(0);

		realtime.publish("policies", 9);
		await settle();
		expect(events).toEqual([]);
	});

	it("ends subscriptions on a tenant switch and never connects a stale session", async () => {
		const { client, realtime, events, listen } = await setup();
		const unsubscribe = listen();
		await settle();
		events.length = 0;

		const stale = client.collection("policies");
		await client.useTenant("t2");
		expect(realtime.open()).toHaveLength(0);
		expect(() => stale.subscribe("*", () => {})).toThrow(/changed/);
		realtime.publish("policies", 2);
		await settle();
		expect(events).toEqual([]);
		unsubscribe();

		// A session answer arriving after a switch is dropped.
		listen();
		await client.useTenant("t1");
		await settle();
		expect(realtime.open()).toHaveLength(0);
	});

	it("retries a failed session with backoff and stops retrying after unsubscribe", async () => {
		const { realtime, state, listen } = await setup();
		state.sessionStatus = 503;
		const unsubscribe = listen();
		await settle();
		expect(state.sessions).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(state.sessions).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(state.sessions).toHaveLength(2);
		state.sessionStatus = 200;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(state.sessions).toHaveLength(3);
		expect(realtime.open()).toHaveLength(1);

		unsubscribe();
		expect(realtime.open()).toHaveLength(0);
		state.sessionStatus = 503;
		const again = listen();
		await settle();
		expect(state.sessions).toHaveLength(4);
		again();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(state.sessions).toHaveLength(4);
	});
});
