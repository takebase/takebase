import { defineConfig, devices } from "@playwright/test";
import { appUrl } from "./ops/production.ts";

// The browser smoke against the deployed production app (`pnpm production:e2e`,
// SEGU-231). Nothing is started locally.
export default defineConfig({
	testDir: "tests/e2e",
	testMatch: "production-*.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 120_000,
	expect: { timeout: 30_000 },
	reporter: [["list"]],
	use: { baseURL: appUrl, trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
