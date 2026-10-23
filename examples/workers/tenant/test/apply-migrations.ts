import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Apply the real tenant migrations, as Wrangler would, to both tenant databases.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.OTHER_TENANT_DB, env.TEST_MIGRATIONS);
