import { expect, type Page, test, type WebSocket } from "@playwright/test";
import { password, signIn, type Tenant, tenants, tenantUrl, users } from "../../ops/staging.ts";
import { addStagingMembership, removeStagingMembership } from "../../ops/staging-journey.ts";

// S-4-4-01: the protected realtime journey in a real browser against deployed
// staging (pnpm staging:e2e): the app on workers.dev, real Firebase Auth and
// RTDB, the deployed Workers and remote D1. The app refetches its list only on
// realtime signals, so every list change below came through RTDB. Calls made
// from the test itself stand for a second device of the same user. Staging data
// persists between runs: numbers are unique and no list is assumed empty.

const [tenantA, tenantB] = tenants;
const records = "/api/collections/policies/records";
const stamp = Date.now().toString(36).toUpperCase();

const createElsewhere = async (tenant: Tenant, token: string, number: string, status = "pending") => {
	const response = await fetch(`${tenantUrl(tenant)}${records}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ number, holder: "Second Device", status }),
	});
	expect(response.status, `create ${number} in ${tenant.id}`).toBe(201);
};

// The database a Firebase RTDB socket belongs to. A real database is named by
// its host (wss://<instance>.firebaseio.com/.ws); a socket moved to a shared
// server host names it in `ns=` instead.
const instanceOf = (url: string) => {
	const { hostname, searchParams } = new URL(url);
	return searchParams.get("ns") ?? (hostname.endsWith(".firebaseio.com") ? hostname.split(".")[0] : null);
};

// Everything the page sends to the tenant Workers, and every RTDB socket it opens.
const watch = (page: Page) => {
	const requests: { method: string; url: string }[] = [];
	const sockets: WebSocket[] = [];
	page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
	page.on("websocket", (socket) => {
		if (instanceOf(socket.url())?.startsWith("takebase-staging-")) sockets.push(socket);
	});
	const toTenant = (tenant?: Tenant) => (url: string) =>
		tenant ? url.startsWith(tenantUrl(tenant)) : tenants.some((each) => url.startsWith(tenantUrl(each)));
	return {
		mark: () => requests.length,
		toTenant: (since: number, tenant?: Tenant) => requests.slice(since).filter(({ url }) => toTenant(tenant)(url)),
		sessions: (tenant: Tenant) =>
			requests.filter(({ method, url }) => method === "POST" && url === `${tenantUrl(tenant)}/api/realtime/session`)
				.length,
		open: (tenant?: Tenant) =>
			sockets.filter((socket) => !socket.isClosed() && (!tenant || instanceOf(socket.url()) === tenant.instance))
				.length,
	};
};

// Long enough for a signal and its refetch to arrive over the internet, had
// anything still listened.
const quiet = 4_000;

const signInAs = async (page: Page, name: "alice" | "bob") => {
	await page.goto("/");
	const form = page.getByTestId("sign-in");
	await form.getByLabel("Email").fill(users[name].email);
	await form.getByLabel("Password").fill(password(name));
	await form.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByTestId("user")).toHaveText(users[name].email);
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
	const alice = await signIn(users.alice.email, password("alice"));
	const list = page.getByTestId("policy-list");
	const policiesSection = page.getByTestId("policies");
	const tenantButtons = page.getByTestId("tenants").getByRole("button");
	const created = `A${stamp}`;
	const elsewhereA = `A${stamp}X`;
	const missed = `B${stamp}`;
	const late = `B${stamp}X`;

	await test.step("sign in and select tenant A", async () => {
		await signInAs(page, "alice");
		await expect(tenantButtons).toHaveCount(2);
		await tenantButtons.filter({ hasText: "Tenant A" }).click();
		await expect(policiesSection).toHaveAttribute("data-tenant", "tenant-a");
		await expect(page.getByTestId("policy-count")).toBeVisible();
		await expect.poll(() => browser.open(tenantA)).toBe(1);
		expect(browser.sessions(tenantA)).toBe(1);
	});

	await test.step(`create ${created} and see it arrive through the signal`, async () => {
		const form = page.getByTestId("create-policy");
		await form.getByLabel("Number").fill(created);
		await form.getByLabel("Holder").fill("Ada Lovelace");
		await form.getByLabel("Status").selectOption("pending");
		const response = page.waitForResponse(
			(each) => each.url() === `${tenantUrl(tenantA)}${records}` && each.request().method() === "POST",
		);
		await form.getByRole("button", { name: "Create" }).click();
		expect((await response).status()).toBe(201);
		const afterCreate = browser.mark();
		await expect(list.getByRole("listitem").first()).toHaveText(`${created} · pending`);
		// The list was refetched after the create, and the create itself does not refetch.
		expect(browser.toTenant(afterCreate, tenantA).some(({ method }) => method === "GET")).toBe(true);
	});

	await test.step("switch to tenant B: nothing from tenant A stays or still listens", async () => {
		await tenantButtons.filter({ hasText: "Tenant B" }).click();
		await expect(policiesSection).toHaveAttribute("data-tenant", "tenant-b");
		await expect(page.getByTestId("policy-count")).toBeVisible();
		await expect(list).not.toContainText(created);
		await expect.poll(() => browser.open(tenantA)).toBe(0);
		await expect.poll(() => browser.open(tenantB)).toBe(1);
		const switched = browser.mark();
		await createElsewhere(tenantA, alice.token, elsewhereA);
		await page.waitForTimeout(quiet);
		expect(browser.toTenant(switched, tenantA)).toEqual([]);
		await expect(list).not.toContainText(elsewhereA);
	});

	await test.step("reconnect: one new session and a catch-up of what was missed", async () => {
		const sessions = browser.sessions(tenantB);
		await context.setOffline(true);
		await expect.poll(() => browser.open(tenantB)).toBe(0);
		await createElsewhere(tenantB, alice.token, missed, "active");
		await context.setOffline(false);
		await expect(list.getByRole("listitem").first()).toHaveText(`${missed} · active`);
		await expect.poll(() => browser.open(tenantB)).toBe(1);
		expect(browser.sessions(tenantB)).toBe(sessions + 1);
		expect(browser.open()).toBe(1);
	});

	await test.step("sign out: no private state and no listener left", async () => {
		const before = browser.mark();
		await page.getByRole("button", { name: "Sign out" }).click();
		await expect.poll(() => browser.open()).toBe(0);
		await createElsewhere(tenantB, alice.token, late);
		await page.waitForTimeout(quiet);
		expect(browser.toTenant(before)).toEqual([]);
		await expectSignedOutAndClean(page, [created, elsewhereA, missed, late]);
	});
});

test("a member removed from the tenant is signed out with a notice", async ({ page }) => {
	const browser = watch(page);
	const bob = await signIn(users.bob.email, password("bob"));
	await signInAs(page, "bob");
	const tenantButtons = page.getByTestId("tenants").getByRole("button");
	await expect(tenantButtons).toHaveCount(1);
	await tenantButtons.filter({ hasText: "Tenant A" }).click();
	const first = page.getByTestId("policy-list").getByRole("listitem").first();
	await expect(first).toBeVisible();
	const seen = ((await first.textContent()) ?? "").split(" · ")[0] ?? "";
	await expect.poll(() => browser.open(tenantA)).toBe(1);

	removeStagingMembership(bob.uid, "tenant-a");
	try {
		// Bob's next request from anywhere is refused, and tenant A revokes his realtime access.
		const response = await fetch(`${tenantUrl(tenantA)}${records}`, {
			headers: { authorization: `Bearer ${bob.token}` },
		});
		expect(response.status).toBe(403);
		await expect(page.getByTestId("notice")).toContainText("access to a tenant was removed");
		await expect.poll(() => browser.open()).toBe(0);
		await expectSignedOutAndClean(page, [seen]);
	} finally {
		// Staging keeps bob as a member of tenant A for the next run.
		addStagingMembership(bob.uid, "tenant-a", "member");
	}
});
