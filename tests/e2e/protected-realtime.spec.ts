import { expect, type Page, test, type WebSocket } from "@playwright/test";
import { namespace, removeMembership, signIn, type TenantId, tenants, tenantUrl, users } from "../fixtures/tenants.ts";

// S-4-3-01: the protected realtime journey in a real browser against the local
// stack (`pnpm dev:stack`). The page refetches its list only when a realtime
// signal arrives, never after its own create, so every list change below came
// through RTDB and an authorized refetch. Calls made from the test itself stand
// for a second device of the same user.

const url = (tenant: TenantId) => tenantUrl(tenants.find(({ id }) => id === tenant)?.port ?? 0);

const api = (tenant: TenantId, token: string, method: string, path: string, body?: unknown) =>
	fetch(`${url(tenant)}${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

const records = "/api/collections/policies/records";

const createElsewhere = async (tenant: TenantId, token: string, number: string, status = "pending") => {
	const response = await api(tenant, token, "POST", records, { number, holder: "Second Device", status });
	expect(response.ok, `create ${number} in ${tenant}`).toBe(true);
};

// Everything the page sends and every RTDB socket it opens.
const watch = (page: Page) => {
	const requests: { method: string; url: string }[] = [];
	const sockets: WebSocket[] = [];
	page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
	// RTDB sockets only (Vite's hot-reload socket is not one).
	page.on("websocket", (socket) => {
		if (new URL(socket.url()).searchParams.get("ns")?.startsWith("demo-takebase-")) sockets.push(socket);
	});
	return {
		mark: () => requests.length,
		// Requests to one tenant Worker (all tenants when omitted) since a mark.
		toTenant: (since: number, tenant?: TenantId) =>
			requests
				.slice(since)
				.filter(({ url: target }) =>
					tenant ? target.startsWith(url(tenant)) : tenants.some(({ id }) => target.startsWith(url(id))),
				),
		sessions: (tenant: TenantId) =>
			requests.filter(
				({ method, url: target }) => method === "POST" && target === `${url(tenant)}/api/realtime/session`,
			).length,
		open: (tenant?: TenantId) =>
			sockets.filter((socket) => !socket.isClosed() && (!tenant || socket.url().includes(`ns=${namespace(tenant)}`)))
				.length,
	};
};

// Long enough for a signal and its refetch to arrive, had anything still listened.
const quiet = 2_000;

const signInAs = async (page: Page, email: string) => {
	await page.goto("/");
	const form = page.getByTestId("sign-in");
	await form.getByLabel("Email").fill(email);
	await form.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByTestId("user")).toHaveText(email);
};

const expectSignedOutAndClean = async (page: Page, seen: string[]) => {
	await expect(page.getByTestId("sign-in")).toBeVisible();
	await expect(page.getByTestId("user")).toHaveCount(0);
	await expect(page.getByTestId("policies")).toHaveCount(0);
	for (const number of seen) await expect(page.locator("body")).not.toContainText(number);
	const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
	for (const number of seen) expect(stored).not.toContain(number);
	// Firebase Auth kept no session either: a reload stays signed out.
	await page.reload();
	await expect(page.getByTestId("sign-in")).toBeVisible();
};

test("an agent's list follows realtime across a tenant switch, a reconnect and sign-out", async ({ page, context }) => {
	const browser = watch(page);
	const alice = await signIn(users.alice.email);
	const list = page.getByTestId("policy-list");
	const count = page.getByTestId("policy-count");
	const policiesSection = page.getByTestId("policies");
	const tenantButtons = page.getByTestId("tenants").getByRole("button");

	await test.step("sign in and select tenant A", async () => {
		await signInAs(page, users.alice.email);
		await expect(tenantButtons).toHaveCount(2);
		await tenantButtons.filter({ hasText: "Tenant A" }).click();
		await expect(policiesSection).toHaveAttribute("data-tenant", "tenant-a");
		await expect(count).toHaveText("0 policies");
		await expect.poll(() => browser.open("tenant-a")).toBe(1);
		expect(browser.sessions("tenant-a")).toBe(1);
	});

	await test.step("create ABC123 and see it arrive through the signal", async () => {
		const form = page.getByTestId("create-policy");
		await form.getByLabel("Number").fill("ABC123");
		await form.getByLabel("Holder").fill("Ada Lovelace");
		await form.getByLabel("Status").selectOption("pending");
		const created = page.waitForResponse(
			(response) => response.url() === `${url("tenant-a")}${records}` && response.request().method() === "POST",
		);
		await form.getByRole("button", { name: "Create" }).click();
		expect((await created).status()).toBe(201);
		const afterCreate = browser.mark();
		await expect(list.getByRole("listitem")).toHaveText(["ABC123 · pending"]);
		await expect(count).toHaveText("1 policy");
		// The list was refetched after the create, and the create itself does not refetch.
		expect(browser.toTenant(afterCreate, "tenant-a").some(({ method }) => method === "GET")).toBe(true);
	});

	await test.step("switch to tenant B: nothing from tenant A stays or still listens", async () => {
		await tenantButtons.filter({ hasText: "Tenant B" }).click();
		await expect(policiesSection).toHaveAttribute("data-tenant", "tenant-b");
		await expect(count).toHaveText("0 policies");
		await expect(list).not.toContainText("ABC123");
		await expect.poll(() => browser.open("tenant-a")).toBe(0);
		await expect.poll(() => browser.open("tenant-b")).toBe(1);
		const switched = browser.mark();
		await createElsewhere("tenant-a", alice.token, "ABC124");
		await page.waitForTimeout(quiet);
		expect(browser.toTenant(switched, "tenant-a")).toEqual([]);
		await expect(list).not.toContainText("ABC124");
	});

	await test.step("reconnect: one new session and a catch-up of what was missed", async () => {
		const sessions = browser.sessions("tenant-b");
		await context.setOffline(true);
		await expect.poll(() => browser.open("tenant-b")).toBe(0);
		await createElsewhere("tenant-b", alice.token, "XYZ789", "active");
		await context.setOffline(false);
		await expect(list.getByRole("listitem")).toHaveText(["XYZ789 · active"]);
		await expect.poll(() => browser.open("tenant-b")).toBe(1);
		expect(browser.sessions("tenant-b")).toBe(sessions + 1);
		expect(browser.open()).toBe(1);
	});

	await test.step("sign out: no private state and no listener left", async () => {
		const before = browser.mark();
		await page.getByRole("button", { name: "Sign out" }).click();
		await expect.poll(() => browser.open()).toBe(0);
		await createElsewhere("tenant-b", alice.token, "XYZ790");
		await page.waitForTimeout(quiet);
		expect(browser.toTenant(before)).toEqual([]);
		await expectSignedOutAndClean(page, ["ABC123", "XYZ789", "XYZ790"]);
	});
});

test("a member removed from the tenant is signed out with a notice", async ({ page }) => {
	const browser = watch(page);
	const bob = await signIn(users.bob.email);
	await signInAs(page, users.bob.email);
	const tenantButtons = page.getByTestId("tenants").getByRole("button");
	await expect(tenantButtons).toHaveCount(1);
	await tenantButtons.filter({ hasText: "Tenant A" }).click();
	await expect(page.getByTestId("policy-list")).toContainText("ABC123 · pending");
	await expect.poll(() => browser.open("tenant-a")).toBe(1);

	removeMembership(bob.uid, "tenant-a");
	// Bob's next request from anywhere is refused, and tenant A revokes his realtime access.
	expect((await api("tenant-a", bob.token, "GET", records)).status).toBe(403);

	await expect(page.getByTestId("notice")).toContainText("access to a tenant was removed");
	await expect.poll(() => browser.open()).toBe(0);
	await expectSignedOutAndClean(page, ["ABC123", "ABC124"]);
});
