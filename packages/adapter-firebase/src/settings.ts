import { AUTH_EMULATOR_URL, createClient, EMULATOR_URL } from "@takebase/firebase-rtdb";
import { createFirebaseRealtime } from "./adapter.ts";

// Builds the adapter from a tenant Worker's settings, in its composition root.
// Sign-in happens on the first write. With the local emulator the dispatcher
// still signs in as a real user through the Auth emulator, so the rules apply
// exactly as in production; the emulator's admin token is never used here.

export type FirebaseRealtimeSettings = {
	databaseURL: string;
	apiKey: string;
	// The tenant's dispatcher user. Worker secrets only.
	email: string;
	password: string;
	// Emulator only: this tenant's database name (?ns=).
	namespace?: string;
};

export const firebaseRealtime = ({ databaseURL, apiKey, email, password, namespace }: FirebaseRealtimeSettings) => {
	const emulator = databaseURL.replace(/\/$/, "") === EMULATOR_URL;
	const client = createClient({
		databaseURL,
		apiKey,
		email,
		password,
		...(emulator ? { authEmulatorURL: AUTH_EMULATOR_URL, emulatorNamespace: namespace } : {}),
	});
	const connection: Record<string, string> = { provider: "firebase", databaseURL };
	if (emulator && namespace) connection.namespace = namespace;
	return createFirebaseRealtime({ client, connection: Object.freeze(connection) });
};
