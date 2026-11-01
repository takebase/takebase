import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { runCollectionContract } from "./portability-contract.ts";

// S-7-2-01, the local D1 side: `pnpm spike:native` runs the same scenario on
// native SQLite. PORTABILITY_DB starts empty, so the scenario migrates it itself.
it("the collection contract holds on local D1", async () => {
	const checks = await runCollectionContract(env.PORTABILITY_DB, env.TEST_MIGRATIONS);
	expect(checks.length).toBeGreaterThan(20);
	expect(checks.filter(({ ok }) => !ok)).toEqual([]);
	// The one answer the native side gives differently (benchmarks/README.md).
	expect(checks.find(({ name }) => name === "a failed event fails the write")?.detail).toBe("HTTP 409");
});
