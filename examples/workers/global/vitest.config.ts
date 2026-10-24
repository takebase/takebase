import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(new URL("../../../migrations/global", import.meta.url).pathname);

// Test-only bindings: the real global migrations, local emulator trust (allowed
// only because FIREBASE_PROJECT_ID is demo-takebase) and, inside
// `firebase emulators:exec`, the Auth emulator host for the S-3-1-01 test.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: migrations,
					TAKEBASE_AUTH_EMULATOR: "local-only",
					TEST_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "",
				},
			},
		}),
	],
	// The first request starts workerd and local D1; on a busy CI runner that can
	// exceed vitest's 5 s default.
	test: { setupFiles: ["./test/apply-migrations.ts"], testTimeout: 20_000 },
});
