import { defineConfig, devices } from "@playwright/test";

// The S-7-3-01 journey in a browser, against a project generated from the packed
// packages (`pnpm e2e:starter`). Its web server packs, generates, installs,
// typechecks and serves that project, so it starts slowly. Local emulators only.
export default defineConfig({
	testDir: "tests/e2e",
	testMatch: "generated-starter.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	expect: { timeout: 15_000 },
	reporter: [["list"]],
	use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: "node tests/fixtures/generated-starter.ts",
		url: "http://localhost:5173",
		reuseExistingServer: false,
		timeout: 480_000,
		gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
		stdout: "pipe",
		stderr: "pipe",
	},
});
