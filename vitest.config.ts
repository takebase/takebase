import { defineConfig } from "vitest/config";

// Root-level checks only; each package runs its own suite via `pnpm -r test`.
export default defineConfig({
	test: {
		include: [
			"tests/architecture/**/*.test.ts",
			"tests/contracts/**/*.test.ts",
			"tests/cli/**/*.test.ts",
			"tests/operations/**/*.test.ts",
			"tests/security/**/*.test.ts",
		],
	},
});
