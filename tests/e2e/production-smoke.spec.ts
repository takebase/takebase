import { expect, type Page, test } from "@playwright/test";
import { adminUrl, password, recordPrefix, tenant, type UserName, users } from "../../ops/production.ts";

// The production smoke in a real browser (pnpm production:e2e, SEGU-231): the
// deployed app and admin, real Firebase Auth and RTDB, the deployed Workers and
// remote D1, on the synthetic tenant. The app refetches its list only on realtime
// signals, so a new row proves the path through RTDB. `pnpm production:cleanup`
// removes the records.

const signInAs = async (page: Page, name: UserName, url = "/") => {
	await page.goto(url);
	const form = page.getByTestId("sign-in");
	await form.getByLabel("Email").fill(users[name].email);
	await form.getByLabel("Password").fill(password(name));
	await form.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByTestId("user")).toHaveText(users[name].email);
};

const selectTenant = (page: Page) =>
	page.getByTestId("tenants").getByRole("button").filter({ hasText: tenant.name }).click();

test("the agent's new record arrives through the realtime signal, and sign-out clears it", async ({ page }) => {
	const number = `${recordPrefix}${Date.now().toString(36).toUpperCase()}`;
	await signInAs(page, "agent");
	await selectTenant(page);
	await expect(page.getByTestId("policies")).toHaveAttribute("data-tenant", tenant.id);
	await expect(page.getByTestId("policy-count")).toBeVisible();

	const form = page.getByTestId("create-policy");
	await form.getByLabel("Number").fill(number);
	await form.getByLabel("Holder").fill("Production Smoke");
	await form.getByLabel("Status").selectOption("pending");
	await form.getByRole("button", { name: "Create" }).click();
	await expect(page.getByTestId("policy-list")).toContainText(`${number} · pending`);

	await page.getByRole("button", { name: "Sign out" }).click();
	await expect(page.getByTestId("sign-in")).toBeVisible();
	await expect(page.locator("body")).not.toContainText(number);
	await page.reload();
	await expect(page.getByTestId("sign-in")).toBeVisible();
});

test("a user with no role sees no tenant in the app", async ({ page }) => {
	await signInAs(page, "outsider");
	await expect(page.getByTestId("policies")).toHaveCount(0);
	await expect(page.getByTestId("tenants").getByRole("button")).toHaveCount(0);
});

test("the admin opens for the tenant's admin and refuses a member", async ({ page }) => {
	await signInAs(page, "agent", adminUrl);
	await selectTenant(page);
	await expect(page.getByTestId("tenant")).toHaveAttribute("data-tenant", tenant.id);
	await expect(page.getByTestId("not-admin")).toHaveCount(0);
	await page.getByRole("button", { name: "Sign out" }).click();
	await expect(page.getByTestId("sign-in")).toBeVisible();

	await signInAs(page, "member", adminUrl);
	await selectTenant(page);
	await expect(page.getByTestId("not-admin")).toBeVisible();
});
