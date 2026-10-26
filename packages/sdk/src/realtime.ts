import type { RealtimeSession } from "@takebase/contracts";
import { readResponse, TakebaseError } from "./errors.ts";
import type { Http } from "./http.ts";
import { createSubscription, type SubscriptionCallback } from "./subscription.ts";

// The realtime connector contract: how the SDK listens to one tenant's signals
// without knowing the service. `@takebase/adapter-firebase/client` implements it
// for Firebase RTDB; the SDK itself never imports a realtime service.

export type RealtimeEvents = {
	// The connection to the service came up (true) or dropped (false).
	connected: (online: boolean) => void;
	// This user's access entry disappeared or the service denied a read. The SDK
	// asks the API whether the user is still a member before acting on it.
	lost: () => void;
};

export type RealtimeConnection = {
	// Calls `next` with the collection's current revision (0 when none), then
	// with every change. Returns a function that stops listening.
	watch: (collection: string, next: (revision: number) => void) => () => void;
	// Stops every listener and releases the connection.
	close: () => void;
};

// Connects with a session from POST /api/realtime/session.
export type RealtimeConnector = (session: RealtimeSession, events: RealtimeEvents) => RealtimeConnection;

export type RealtimeOptions = {
	connector: RealtimeConnector;
	// Signals within this many milliseconds reach a subscriber as one call. Default 50.
	coalesceMs?: number;
};

const isSession = (value: unknown): value is RealtimeSession => {
	if (typeof value !== "object" || value === null) return false;
	const { uid, revision, connection } = value as Record<string, unknown>;
	return (
		typeof uid === "string" &&
		typeof revision === "number" &&
		typeof connection === "object" &&
		connection !== null &&
		Object.values(connection).every((item) => typeof item === "string")
	);
};

const readSession = async (response: Response) => {
	const body = await readResponse<unknown>(response);
	if (!isSession(body))
		throw new TakebaseError(response.status, "invalid_response", "Response is not a realtime session");
	return body;
};

const firstRetryMs = 1_000;
const maxRetryMs = 30_000;
const stableMs = 5_000;

type Watcher = {
	collection: string;
	subscription: ReturnType<typeof createSubscription>;
	stop: (() => void) | null;
};

export type TenantRealtimeOptions = RealtimeOptions & {
	// The selected tenant's requests; they fail with `tenant_changed` after a switch.
	http: Http;
	// The API confirmed that this user lost access to the tenant.
	revoked: () => void;
};

// Realtime for one tenant selection. The first subscription opens a session and
// a connection; the last unsubscribe closes it. Access loss and reconnects open
// a new session, so the API's membership check decides every connection.
export const createTenantRealtime = ({ http, connector, coalesceMs = 50, revoked }: TenantRealtimeOptions) => {
	const watchers = new Set<Watcher>();
	let connection: RealtimeConnection | null = null;
	let opening: Promise<void> | null = null;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let retryMs = firstRetryMs;
	let connectedAt = 0;
	let closed = false;

	// Each connection's first revision is a catch-up.
	const attach = (watcher: Watcher) => {
		if (connection === null) return;
		let first = true;
		watcher.stop = connection.watch(watcher.collection, (revision) => {
			watcher.subscription.deliver(revision, first);
			first = false;
		});
	};

	const disconnect = () => {
		for (const watcher of watchers) {
			watcher.stop?.();
			watcher.stop = null;
		}
		connection?.close();
		connection = null;
	};

	const retryLater = () => {
		clearTimeout(retry);
		retry = setTimeout(() => {
			retry = undefined;
			void open();
		}, retryMs);
		retryMs = Math.min(retryMs * 2, maxRetryMs);
	};

	const connect = (session: RealtimeSession) => {
		let current: RealtimeConnection | null = null;
		let seenOnline = false;
		let wentOffline = false;
		connectedAt = Date.now();
		// Events run after the connector returns, and only while it is current.
		const live =
			<Args extends unknown[]>(handle: (...args: Args) => void) =>
			(...args: Args) =>
				queueMicrotask(() => {
					if (current !== null && connection === current) handle(...args);
				});
		current = connector(session, {
			// Services may report "offline" before the first connect; only a drop
			// after being online is a reconnect.
			connected: live((online: boolean) => {
				if (!online) wentOffline = seenOnline;
				else if (wentOffline) refresh();
				else seenOnline = true;
			}),
			lost: live(() => refresh()),
		});
		connection = current;
		for (const watcher of watchers) attach(watcher);
	};

	const open = () => {
		opening ??= (async () => {
			try {
				const session = await readSession(await http.send("/api/realtime/session", { method: "POST" }));
				if (closed || watchers.size === 0) return;
				disconnect();
				connect(session);
			} catch (error) {
				if (closed) return;
				// 401/403: the API no longer accepts this user for the tenant.
				if (error instanceof TakebaseError && (error.status === 401 || error.status === 403)) revoked();
				else retryLater();
			} finally {
				opening = null;
			}
		})();
		return opening;
	};

	// A connection that ends soon after it opened (e.g. its grant raced the
	// previous connection's disconnect cleanup) reopens with backoff, so it
	// cannot loop; a connection that held is reopened at once.
	const refresh = () => {
		disconnect();
		if (Date.now() - connectedAt < stableMs) retryLater();
		else {
			retryMs = firstRetryMs;
			void open();
		}
	};

	const subscribe = (collection: string, callback: SubscriptionCallback) => {
		if (closed) throw new TakebaseError(0, "tenant_changed", "The selected tenant or user changed");
		const watcher: Watcher = {
			collection,
			subscription: createSubscription(collection, callback, coalesceMs),
			stop: null,
		};
		watchers.add(watcher);
		if (connection !== null) attach(watcher);
		else void open();
		return () => {
			if (!watchers.delete(watcher)) return;
			watcher.stop?.();
			watcher.subscription.cancel();
			if (watchers.size > 0) return;
			clearTimeout(retry);
			retryMs = firstRetryMs;
			disconnect();
		};
	};

	const close = () => {
		closed = true;
		clearTimeout(retry);
		disconnect();
		for (const watcher of watchers) watcher.subscription.cancel();
		watchers.clear();
	};

	return { subscribe, close };
};

export type TenantRealtime = ReturnType<typeof createTenantRealtime>;
