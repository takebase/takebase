import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Run the same suite once per tenant environment; each has its own D1 database.
const tenantProject = (environment: "tenant-a" | "tenant-b") => ({
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc", environment } })],
	test: { name: environment },
});

export default defineConfig({
	test: { projects: [tenantProject("tenant-a"), tenantProject("tenant-b")] },
});
