import type { D1Migration } from "cloudflare:test";

// Test-only bindings added in vitest.config.ts; production Workers have none of them.
declare global {
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
			TAKEBASE_AUTH_EMULATOR: string;
			TEST_AUTH_EMULATOR_HOST: string;
		}
	}
}
