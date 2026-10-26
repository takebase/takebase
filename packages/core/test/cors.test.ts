import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { browserCors } from "../src/index.ts";

const appWith = (origins: string | undefined) => {
	const app = new Hono();
	app.use("*", browserCors(origins));
	app.get("/api/tenants", (c) => c.json({ ok: true }));
	return app;
};

const preflight = (origin: string) => ({
	method: "OPTIONS",
	headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization" },
});

describe("browserCors", () => {
	it("answers only listed origins, without credentials", async () => {
		const app = appWith("http://localhost:5173, https://app.example");
		const allowed = await app.request("/api/tenants", preflight("http://localhost:5173"));
		expect(allowed.status).toBe(204);
		expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
		expect(allowed.headers.get("access-control-allow-headers")).toContain("authorization");
		expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();

		const other = await app.request("/api/tenants", { headers: { origin: "https://attacker.example" } });
		expect(other.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("adds no CORS headers when no origins are configured", async () => {
		for (const origins of [undefined, "", " , "]) {
			const response = await appWith(origins).request("/api/tenants", { headers: { origin: "http://localhost:5173" } });
			expect(response.status).toBe(200);
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
		}
	});
});
