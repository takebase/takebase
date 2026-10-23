import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("global Worker", () => {
	it("reports health with its D1 binding", async () => {
		const response = await exports.default.fetch("https://global.local/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ service: "global", status: "ok", database: "ok" });
	});

	it("does not expose collection routes yet", async () => {
		const response = await exports.default.fetch("https://global.local/api/collections/posts/records");
		expect(response.status).toBe(404);
	});
});
