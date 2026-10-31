import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { addMember, addTenant, emulatorToken } from "./fixtures.ts";

// SEGU-228 (R-7-1-01): what the global Worker's public boundary must hold under
// overlapping requests and oversized input.

const call = (path: string, user: string, init: RequestInit = {}) =>
	exports.default.fetch(`https://global.local${path}`, {
		...init,
		headers: { authorization: `Bearer ${emulatorToken(user)}`, "content-type": "application/json" },
	});

describe("global Worker boundaries (R-7-1-01)", () => {
	it("overlapping admin requests never share a caller", async () => {
		await addTenant("overlap");
		await addTenant("overlap-other");
		await addMember("overlap", "overlap-admin", "admin");
		await addMember("overlap", "overlap-agent", "agent");
		await addMember("overlap-other", "overlap-other-admin", "admin");
		const users = Array.from(
			{ length: 30 },
			(_, index) => ["overlap-admin", "overlap-agent", "overlap-other-admin"][index % 3] ?? "",
		);
		const responses = await Promise.all(users.map((user) => call("/api/admin/tenants/overlap/members", user)));
		expect(responses.map(({ status }) => status)).toEqual(users.map((user) => (user === "overlap-admin" ? 200 : 403)));
	});

	it("refuses an oversized body before parsing it", async () => {
		await addTenant("oversized");
		await addMember("oversized", "oversized-admin", "admin");
		const body = JSON.stringify({ token: "x".repeat(2 * 1024 * 1024) });
		for (const path of ["/api/invites/redeem", "/api/admin/tenants/oversized/roles"]) {
			const response = await call(path, "oversized-admin", { method: "POST", body });
			expect(response.status).toBe(413);
		}
	});

	it("limits invitation redemption once the limiter says so", async () => {
		const response = await app.fetch(new Request("https://global.local/api/invites/redeem", { method: "POST" }), {
			...env,
			RATE_LIMITER: { limit: async () => ({ success: false }) },
		});
		expect(response.status).toBe(429);
	});
});
