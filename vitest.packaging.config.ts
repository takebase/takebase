import { defineConfig } from "vitest/config";

// Packs the packages and installs them into a disposable consumer, so it needs
// the registry and takes minutes: run with `pnpm test:packaging`, not `pnpm test`.
export default defineConfig({
	test: {
		include: ["tests/packaging/**/*.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 420_000,
	},
});
