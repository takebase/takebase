import { firebaseConnector } from "@takebase/adapter-firebase/client";
import { createClient, type TakebaseClient } from "@takebase/sdk";
import { type FirebaseApp, initializeApp } from "firebase/app";
import { type Auth, connectAuthEmulator, getAuth } from "firebase/auth";

// The one Firebase app and Takebase client, created on first use in the browser.
// Defaults run `pnpm dev`. A demo-* project only ever talks to the Auth emulator;
// set the VITE_* variables for anything else.

const config = {
	globalUrl: import.meta.env.VITE_TAKEBASE_GLOBAL_URL ?? "http://localhost:8787",
	apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "demo-api-key",
	projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "demo-{{name}}",
	authEmulator: import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_URL ?? "http://127.0.0.1:9099",
};

export type Takebase = { app: FirebaseApp; auth: Auth; client: TakebaseClient };

let takebase: Takebase | null = null;

export const useTakebase = (): Takebase => {
	if (takebase) return takebase;
	const app = initializeApp({ apiKey: config.apiKey, projectId: config.projectId });
	const auth = getAuth(app);
	if (config.projectId.startsWith("demo-")) connectAuthEmulator(auth, config.authEmulator, { disableWarnings: true });
	const client = createClient({ globalUrl: config.globalUrl, auth, realtime: { connector: firebaseConnector(app) } });
	takebase = { app, auth, client };
	return takebase;
};
