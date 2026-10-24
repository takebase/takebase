import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Apply the real global migrations, as Wrangler would.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
