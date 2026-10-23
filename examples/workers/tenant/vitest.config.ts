import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(new URL("../../../migrations/tenant", import.meta.url).pathname);

// Run the same suite once per tenant environment; each has its own D1 database.
// OTHER_TENANT_DB is a test-only second tenant database used to prove isolation.
const tenantProject = (environment: "tenant-a" | "tenant-b") => ({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc", environment },
			miniflare: {
				bindings: { TEST_MIGRATIONS: migrations },
				d1Databases: { OTHER_TENANT_DB: `${environment}-other-tenant` },
			},
		}),
	],
	// The first request starts workerd and local D1; on a busy CI runner that can
	// exceed vitest's 5 s default.
	test: { name: environment, setupFiles: ["./test/apply-migrations.ts"], testTimeout: 20_000 },
});

export default defineConfig({
	test: { projects: [tenantProject("tenant-a"), tenantProject("tenant-b")] },
});
