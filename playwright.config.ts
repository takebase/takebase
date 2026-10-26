import { defineConfig, devices } from "@playwright/test";

// Browser tests of the local milestone (`pnpm test:e2e`). Playwright starts the
// whole stack with `pnpm dev:stack` (emulators and local D1 only, freshly seeded
// on every start) and stops it with SIGTERM, so the stack can stop its Worker
// and Vite processes. The tests share that stack, so they run one at a time.
export default defineConfig({
	testDir: "tests/e2e",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	expect: { timeout: 15_000 },
	reporter: [["list"]],
	use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: "pnpm dev:stack",
		url: "http://localhost:5173",
		// A running stack holds data from earlier runs; always start a fresh one.
		reuseExistingServer: false,
		timeout: 180_000,
		gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
		stdout: "ignore",
		stderr: "pipe",
	},
});
