import { defineConfig } from "drizzle-kit";

// Generates SQL migrations only; Wrangler applies them to each tenant's D1.
export default defineConfig({
	dialect: "sqlite",
	schema: "./src/schema",
	out: "../../../migrations/tenant",
});
