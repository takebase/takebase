import { expect, type Page, test } from "@playwright/test";
import { adminOrigin, password, removePolicy, signIn, tenants, tenantUrl, users } from "../fixtures/tenants.ts";

// S-5-4-01 (SEGU-222): the admin (packages/adminui, :5174) in a real browser
// against the local stack. It uses the public SDK only, so every refusal below
// comes from a Worker. Calls made from the test itself stand for another user
// working in the same tenant.

const tenantA = tenantUrl(tenants.find(({ id }) => id === "tenant-a")?.port ?? 0);
const records = `${tenantA}/api/collections/policies/records`;
const refused = "Only an admin of this tenant may do this";

const api = async (token: string, method: string, url: string, body?: unknown) => {
	const response = await fetch(url, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	expect(response.ok, `${method} ${url}`).toBe(true);
	return (await response.json()) as { id: string };
};

// Playwright waits for the app (:5173); the admin starts alongside it.
test.beforeAll(async () => {
	await expect(async () => expect((await fetch(adminOrigin)).ok).toBe(true)).toPass({ timeout: 30_000 });
});

// The other specs expect tenant A without policies; the API never deletes one.
const created: string[] = [];
test.afterAll(() => {
	for (const id of created) removePolicy("tenant-a", id);
});

const signInAs = async (page: Page, email: string) => {
	await page.goto(adminOrigin);
	const form = page.getByTestId("sign-in");
	await form.getByLabel("Email").fill(email);
	await form.getByLabel("Password").fill(password);
	await form.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByTestId("user")).toHaveText(email);
};

const selectTenant = (page: Page, name: string) =>
	page.getByTestId("tenants").getByRole("button").filter({ hasText: name }).click();

const screen = (page: Page, name: string) =>
	page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name }).click();

test("an admin administers tenant A, follows realtime, is refused where the rules say so, and signs out", async ({
	page,
}) => {
	const alice = await signIn(users.alice.email);
	const carol = await signIn(users.carol.email);
	const number = `ADM-${Date.now().toString(36)}`;
	const { id } = await api(alice.token, "POST", records, { number, holder: "Admin Journey", status: "pending" });
	created.push(id);
	const row = page.getByTestId("records").locator(`tr[data-id="${id}"]`);

	await test.step("sign in and select tenant A", async () => {
		await signInAs(page, users.carol.email);
		await selectTenant(page, "Tenant A");
		await expect(page.getByTestId("tenant")).toHaveAttribute("data-tenant", "tenant-a");
		await expect(page.getByTestId("not-admin")).toHaveCount(0);
	});

	await test.step("members, roles and the rule matrix", async () => {
		await screen(page, "Members, roles and invitations");
		await expect(page.getByTestId("members").locator(`tr[data-uid="${carol.uid}"]`)).toContainText("admin");
		await expect(page.getByTestId("roles").locator('tr[data-role="admin"]')).toBeVisible();
		const policies = page.getByTestId("rule-matrix").locator('tr[data-collection="policies"]');
		await expect(policies.locator('td[data-operation="delete"]')).toHaveText("deny");
		await expect(policies.locator('td[data-operation="update"]')).toHaveText("tenantMember");
	});

	await test.step("update a policy", async () => {
		await screen(page, "Collections");
		await page.getByTestId("collections").getByRole("button", { name: "policies" }).click();
		await expect(page.getByTestId("realtime")).toHaveAttribute("data-live", "true");
		await row.getByRole("button", { name: "Edit" }).click();
		await page.getByTestId("record-form").getByLabel("status").fill("active");
		await page.getByTestId("record-form").getByRole("button", { name: "Save" }).click();
		await expect(page.getByTestId("record-form")).toHaveCount(0);
		await expect(row).toContainText("active");
	});

	await test.step("another user's change arrives through realtime", async () => {
		const before = Number(await page.getByTestId("refetches").textContent());
		await api(alice.token, "PATCH", `${records}/${id}`, { status: "cancelled" });
		await expect(row).toContainText("cancelled");
		expect(Number(await page.getByTestId("refetches").textContent())).toBeGreaterThan(before);
	});

	await test.step("the delete rule refuses even an admin", async () => {
		await row.getByRole("button", { name: "Delete" }).click();
		await expect(page.getByTestId("collections-error")).toBeVisible();
		await expect(row).toBeVisible();
	});

	await test.step("outbox and diagnostics", async () => {
		await screen(page, "Diagnostics");
		await expect(page.getByTestId("readiness").locator('tr[data-worker="global"]')).toHaveAttribute(
			"data-status",
			"ok",
		);
		await expect(page.getByTestId("readiness").locator('tr[data-worker="tenant"]')).toHaveAttribute(
			"data-status",
			"ok",
		);
		// Delivery runs after each write's response, so the counts settle shortly.
		await expect(async () => {
			await page.getByTestId("diagnostics").getByRole("button", { name: "Refresh" }).click();
			await expect(page.getByTestId("outbox").locator('[data-count="pending"]')).toHaveText("0", { timeout: 1_000 });
		}).toPass();
		expect(Number(await page.getByTestId("outbox").locator('[data-count="delivered"]').textContent())).toBeGreaterThan(
			0,
		);
		await expect(page.getByTestId("outbox").locator('[data-count="dead"]')).toHaveText("0");
		await expect(page.getByTestId("migrations").locator("li").first()).toBeVisible();
	});

	await test.step("tenant B's Worker refuses a member who is no admin there", async () => {
		await selectTenant(page, "Tenant B");
		await expect(page.getByTestId("diagnostics")).toHaveAttribute("data-tenant", "tenant-b");
		await expect(page.getByTestId("diagnostics-error")).toHaveText(refused);
		await expect(page.getByTestId("outbox")).toHaveCount(0);
	});

	await test.step("sign out leaves nothing behind", async () => {
		await page.getByRole("button", { name: "Sign out" }).click();
		await expect(page.getByTestId("sign-in")).toBeVisible();
		await expect(page.locator("body")).not.toContainText(number);
		await expect(page.locator("body")).not.toContainText(carol.uid);
		await page.reload();
		await expect(page.getByTestId("sign-in")).toBeVisible();
	});
});

test("a member who is no admin gets the Workers' refusal on every admin screen", async ({ page }) => {
	await signInAs(page, users.bob.email);
	await selectTenant(page, "Tenant A");
	await expect(page.getByTestId("not-admin")).toBeVisible();

	await screen(page, "Members, roles and invitations");
	await expect(page.getByTestId("access-error")).toHaveText(refused);
	await expect(page.getByTestId("members")).toHaveCount(0);

	await screen(page, "Collections");
	await expect(page.getByTestId("collections-error")).toHaveText(refused);
	await expect(page.getByRole("navigation", { name: "Collections" })).toHaveCount(0);

	await screen(page, "Diagnostics");
	await expect(page.getByTestId("diagnostics-error")).toHaveText(refused);
	await expect(page.getByTestId("outbox")).toHaveCount(0);
});
