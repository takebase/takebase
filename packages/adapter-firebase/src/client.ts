import type { RealtimeConnector } from "@takebase/sdk";
import type { FirebaseApp } from "firebase/app";
import { getDatabase, goOffline, goOnline, onDisconnect, onValue, ref } from "firebase/database";

// The browser side of the Firebase adapter: the SDK's realtime connector for a
// tenant's Realtime Database (layout in rules.ts). It reads only what the rules
// give a member, signals and the user's own grant, and its only write is
// deleting that grant when the connection drops (onDisconnect). Data always
// comes from the API afterwards.
//
//   createClient({ ..., realtime: { connector: firebaseConnector(app) } })
//
// `app` is the application's FirebaseApp; RTDB authenticates with its signed-in
// Auth user.

// Firebase keys exclude . # $ [ ] / and control characters.
const keyPattern = /^[^.#$[\]/\p{Cc}]{1,768}$/u;

const databaseUrl = ({ databaseURL, namespace }: Record<string, string>) => {
	if (!databaseURL) throw new TypeError("The realtime session has no databaseURL");
	// The emulator serves every tenant's database from one host, selected by ?ns=.
	return namespace ? `${databaseURL.replace(/\/$/, "")}?ns=${encodeURIComponent(namespace)}` : databaseURL;
};

export const firebaseConnector =
	(app: FirebaseApp): RealtimeConnector =>
	(session, events) => {
		if (session.connection.provider !== "firebase") throw new TypeError("The realtime session is not for Firebase");
		if (!keyPattern.test(session.uid)) throw new TypeError("Invalid realtime user id");
		const db = getDatabase(app, databaseUrl(session.connection));
		goOnline(db);
		const grant = ref(db, `access/members/${session.uid}`);
		const stops = new Set<() => void>();
		const listen = (stop: () => void) => {
			stops.add(stop);
			return () => {
				stop();
				stops.delete(stop);
			};
		};

		// A removed grant or a denied read: the SDK asks the API what happened.
		listen(
			onValue(
				grant,
				(snapshot) => {
					if (!snapshot.exists()) events.lost();
				},
				() => events.lost(),
			),
		);
		listen(
			onValue(ref(db, ".info/connected"), (snapshot) => {
				const online = snapshot.val() === true;
				// The server forgets onDisconnect once it ran, so arm it on every connect.
				if (online) onDisconnect(grant).remove().catch(events.lost);
				events.connected(online);
			}),
		);

		return {
			watch: (collection, next) =>
				listen(
					onValue(
						ref(db, `collections/${collection}`),
						(snapshot) => {
							const revision: unknown = snapshot.child("revision").val();
							next(typeof revision === "number" ? revision : 0);
						},
						() => events.lost(),
					),
				),
			// Going offline also runs onDisconnect: the grant is removed.
			close: () => {
				for (const stop of stops) stop();
				stops.clear();
				goOffline(db);
			},
		};
	};
