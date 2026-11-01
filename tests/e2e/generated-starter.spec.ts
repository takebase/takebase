import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { starterDir } from "../fixtures/generated-starter.ts";

// S-7-3-01: the protected-realtime journey in a project generated from the packed
// packages. The page refetches only when a realtime signal arrives, never after its
// own create, so every list change below came through RTDB and an authorized refetch.

const auth = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const password = "local-only-password";
const records = "http://localhost:8788/api/collections/notes/records";
const takebase = join(starterDir, "node_modules/.bin/takebase");

const signIn = async (email: string) => {
	const response = await fetch(`${auth}/accounts:signInWithPassword?key=demo-api-key`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password, returnSecureToken: true }),
	});
	expect(response.status).toBe(200);
	return ((await response.json()) as { idToken: string }).idToken;
};

const signUp = async (email: string) => {
	const response = await fetch(`${auth}/accounts:signUp?key=demo-api-key`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password, returnSecureToken: true }),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as { idToken: string; localId: string };
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

test("a generated project serves the protected-realtime journey", async ({ page }) => {
	const list = page.getByTestId("note-list").getByRole("listitem");

	await test.step("sign in, select the tenant and see it empty", async () => {
		await page.goto("/");
		const form = page.getByTestId("sign-in");
		await form.getByLabel("Email").fill("demo@example.test");
		await form.getByLabel("Password").fill(password);
		await form.getByRole("button", { name: "Sign in" }).click();
		await expect(page.getByTestId("user")).toHaveText("demo@example.test");
		await page.getByTestId("tenants").getByRole("button", { name: "Demo" }).click();
		await expect(page.getByTestId("notes")).toHaveAttribute("data-tenant", "demo");
		await expect(list).toHaveCount(0);
	});

	await test.step("a create reaches the list through the signal", async () => {
		const form = page.getByTestId("create-note");
		await form.getByLabel("Title").fill("From the page");
		await form.getByRole("button", { name: "Add" }).click();
		await expect(list).toHaveText(["From the page"]);
	});

	const token = await signIn("demo@example.test");

	await test.step("another device's create reaches the open page", async () => {
		const created = await fetch(records, {
			method: "POST",
			headers: bearer(token),
			body: JSON.stringify({ title: "From a second device", done: false }),
		});
		expect(created.status).toBe(201);
		await expect(list).toHaveText(["From a second device", "From the page"]);
	});

	await test.step("the rules and the membership guard refuse everyone else", async () => {
		expect((await fetch(records)).status).toBe(401);
		const invalid = await fetch(records, { method: "POST", headers: bearer(token), body: JSON.stringify({ done: 1 }) });
		expect(invalid.status).toBe(422);
		const { items } = (await (await fetch(records, { headers: bearer(token) })).json()) as { items: { id: string }[] };
		const denied = await fetch(`${records}/${items[0]?.id}`, { method: "DELETE", headers: bearer(token) });
		expect(denied.status).toBe(403);

		const stranger = await signUp(`stranger-${Date.now()}@example.test`);
		expect((await fetch(records, { headers: bearer(stranger.idToken) })).status).toBe(403);

		const reader = await signUp(`reader-${Date.now()}@example.test`);
		const cli = (...args: string[]) => spawnSync(takebase, args, { cwd: starterDir, encoding: "utf8" });
		expect(cli("role", "create", "demo", "reader").status).toBe(0);
		expect(cli("tenant", "user", "add", "demo", reader.localId, "--role", "reader").status).toBe(0);
		const headers = bearer(reader.idToken);
		expect((await fetch(records, { headers })).status).toBe(200);
		const write = await fetch(records, {
			method: "POST",
			headers,
			body: JSON.stringify({ title: "Not allowed", done: false }),
		});
		expect(write.status).toBe(403);
	});

	await test.step("the tenant from `takebase tenant create` is its own Worker and refuses non-members", async () => {
		const health = (await (await fetch("http://localhost:8789/health")).json()) as { tenantId: string };
		expect(health.tenantId).toBe("acme");
		const other = await fetch("http://localhost:8789/api/collections/notes/records", { headers: bearer(token) });
		expect(other.status).toBe(403);
	});

	await test.step("the project's own health check passes", () => {
		const health = spawnSync(takebase, ["health"], { cwd: starterDir, encoding: "utf8" });
		expect(health.stdout + health.stderr).toContain("All Workers are live and ready.");
		expect(health.status).toBe(0);
	});
});
