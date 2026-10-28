import { expect, type Page, test } from "@playwright/test";
import { adminUrl, password, signIn, tenants, tenantUrl, users } from "../../ops/staging.ts";

// S-5-4-01 against deployed staging (pnpm staging:e2e, SEGU-222): the admin on
// https://takebase-staging-admin.pages.dev, real Firebase Auth and RTDB, the
// deployed Workers and remote D1. `probe` is tenant A's only admin; alice is an
// agent there, not an admin. Staging data persists: the policy number is
// unique, no list or count is assumed, and policies are never deleted (the
// rules deny it). Before running after `ops/staging-firebase.ts check`, remove
// probe's revocation timestamp, or its realtime grant is refused.

const [tenantA] = tenants;
const records = `${tenantUrl(tenantA)}/api/collections/policies/records`;
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

const signInAs = async (page: Page, name: "probe" | "alice") => {
	await page.goto(adminUrl());
	const form = page.getByTestId("sign-in");
	await form.getByLabel("Email").fill(users[name].email);
	await form.getByLabel("Password").fill(password(name));
	await form.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByTestId("user")).toHaveText(users[name].email);
};

const selectTenantA = (page: Page) =>
	page.getByTestId("tenants").getByRole("button").filter({ hasText: "Tenant A" }).click();

const screen = (page: Page, name: string) =>
	page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name }).click();

test("the staging admin administers tenant A, follows realtime and signs out", async ({ page }) => {
	const alice = await signIn(users.alice.email, password("alice"));
	const probe = await signIn(users.probe.email, password("probe"));
	const number = `ADM-${Date.now().toString(36).toUpperCase()}`;
	const { id } = await api(alice.token, "POST", records, { number, holder: "Staging Admin", status: "pending" });
	const row = page.getByTestId("records").locator(`tr[data-id="${id}"]`);

	await test.step("sign in and select tenant A", async () => {
		await signInAs(page, "probe");
		await selectTenantA(page);
		await expect(page.getByTestId("tenant")).toHaveAttribute("data-tenant", "tenant-a");
		await expect(page.getByTestId("not-admin")).toHaveCount(0);
	});

	await test.step("members, roles and the rule matrix", async () => {
		await screen(page, "Members, roles and invitations");
		await expect(page.getByTestId("members").locator(`tr[data-uid="${probe.uid}"]`)).toContainText("admin");
		const policies = page.getByTestId("rule-matrix").locator('tr[data-collection="policies"]');
		await expect(policies.locator('td[data-operation="delete"]')).toHaveText("deny");
	});

	await test.step("update a policy, then another user's change arrives through realtime", async () => {
		await screen(page, "Collections");
		await page.getByTestId("collections").getByRole("button", { name: "policies" }).click();
		await expect(page.getByTestId("realtime")).toHaveAttribute("data-live", "true");
		await row.getByRole("button", { name: "Edit" }).click();
		await page.getByTestId("record-form").getByLabel("status").fill("active");
		await page.getByTestId("record-form").getByRole("button", { name: "Save" }).click();
		await expect(row).toContainText("active");
		await api(alice.token, "PATCH", `${records}/${id}`, { status: "cancelled" });
		await expect(row).toContainText("cancelled");
	});

	await test.step("the delete rule refuses even an admin", async () => {
		await row.getByRole("button", { name: "Delete" }).click();
		await expect(page.getByTestId("collections-error")).toBeVisible();
		await expect(row).toBeVisible();
	});

	await test.step("readiness and the outbox", async () => {
		await screen(page, "Diagnostics");
		await expect(page.getByTestId("readiness").locator('tr[data-worker="global"]')).toHaveAttribute(
			"data-status",
			"ok",
		);
		await expect(page.getByTestId("readiness").locator('tr[data-worker="tenant"]')).toHaveAttribute(
			"data-status",
			"ok",
		);
		await expect(async () => {
			await page.getByTestId("diagnostics").getByRole("button", { name: "Refresh" }).click();
			await expect(page.getByTestId("outbox").locator('[data-count="pending"]')).toHaveText("0", { timeout: 2_000 });
		}).toPass();
	});

	await test.step("a deep link reloads through the SPA fallback", async () => {
		const response = await page.goto(`${adminUrl()}/diagnostics`);
		expect(response?.status()).toBe(200);
		await expect(page.getByTestId("user")).toHaveText(users.probe.email);
		// The selected tenant lives in memory only, so the screen asks again.
		await expect(page.getByText("Select a tenant to administer.")).toBeVisible();
	});

	await test.step("sign out leaves nothing behind", async () => {
		await page.getByRole("button", { name: "Sign out" }).click();
		await expect(page.getByTestId("sign-in")).toBeVisible();
		await expect(page.locator("body")).not.toContainText(number);
		await page.reload();
		await expect(page.getByTestId("sign-in")).toBeVisible();
	});
});

test("an agent who is no admin gets the staging Workers' refusal on every admin screen", async ({ page }) => {
	await signInAs(page, "alice");
	await selectTenantA(page);
	await expect(page.getByTestId("not-admin")).toBeVisible();

	await screen(page, "Members, roles and invitations");
	await expect(page.getByTestId("access-error")).toHaveText(refused);
	await expect(page.getByTestId("members")).toHaveCount(0);

	await screen(page, "Collections");
	await expect(page.getByTestId("collections-error")).toHaveText(refused);

	await screen(page, "Diagnostics");
	await expect(page.getByTestId("diagnostics-error")).toHaveText(refused);
	await expect(page.getByTestId("outbox")).toHaveCount(0);
});
