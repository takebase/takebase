import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The first request starts workerd and local D1; on a busy CI runner that can
// exceed vitest's 5 s default.
export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
	test: { testTimeout: 20_000 },
});
