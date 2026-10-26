import { defineConfig, devices } from "@playwright/test";
import { appUrl } from "./ops/staging.ts";

// The browser journey against the deployed staging app (`pnpm staging:e2e`,
// SEGU-218 S-4-4-01). Nothing is started locally: the tests drive
// https://takebase-staging-app.<subdomain>.workers.dev with the staging users
// from ops/.staging.env. Staging data persists, so the tests use unique numbers
// and never assume an empty list; they run one at a time.
export default defineConfig({
	testDir: "tests/e2e",
	testMatch: "staging-*.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 120_000,
	expect: { timeout: 30_000 },
	reporter: [["list"]],
	use: { baseURL: appUrl(), trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
