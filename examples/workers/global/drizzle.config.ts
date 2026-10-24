import { defineConfig } from "drizzle-kit";

// Generates SQL migrations only; Wrangler applies them to the global D1.
export default defineConfig({
	dialect: "sqlite",
	schema: "./src/schema",
	out: "../../../migrations/global",
});
