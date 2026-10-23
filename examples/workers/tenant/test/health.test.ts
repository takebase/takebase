import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("tenant Worker", () => {
	it("reports health for its own tenant and D1 binding", async () => {
		const response = await exports.default.fetch("https://tenant.local/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			service: "tenant",
			tenantId: env.TENANT_ID,
			status: "ok",
			database: "ok",
		});
		expect(["tenant-a", "tenant-b"]).toContain(env.TENANT_ID);
	});

	it("does not expose collection routes yet", async () => {
		const response = await exports.default.fetch("https://tenant.local/api/collections/posts/records");
		expect(response.status).toBe(404);
	});
});
