import type { D1Migration } from "cloudflare:test";

// Test-only bindings added in vitest.config.ts; production Workers have neither.
declare global {
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
			OTHER_TENANT_DB: D1Database;
			OTHER_TENANT_SECRETS: KVNamespace;
			// A random data key per run (vitest.config.ts); a Worker secret in real deployments.
			DATA_KEY_V1: string;
			// "1" inside `pnpm test:realtime`, when the Auth and Database emulators run.
			TEST_FIREBASE_EMULATORS: string;
		}
	}
}
