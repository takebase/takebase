import { expect, type Page, test } from "@playwright/test";
import { adminUrl, password, signIn, tenants, tenantUrl, users } from "../../ops/staging.ts";

// S-6-5-01 against deployed staging (pnpm staging:e2e, SEGU-227): the admin on
// Cloudflare Pages reads the real private backup bucket through the deployed
// global Worker. `probe` is tenant A's only admin; alice is an agent there.
// Read-only: it uses the backups already in the bucket, assumes no particular
// one, and creates, restores and prunes nothing.

const [tenantA] = tenants;
const refused = "Only an admin of this tenant may do this";

const signInAs = async (page: Page, name: "probe" | "alice") => {
	await page.goto(adminUrl());
	const form = page.getByTestId("sign-in");
	await form.getByLabel("Email").fill(users[name].email);
	await form.getByLabel("Password").fill(password(name));
	await form.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByTestId("user")).toHaveText(users[name].email);
	await page.getByTestId("tenants").getByRole("button").filter({ hasText: "Tenant A" }).click();
};

const screen = (page: Page, name: string) =>
	page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name, exact: true }).click();

test("the staging admin verifies a real backup and reviews its restore; no key or envelope reaches it", async ({
	page,
}) => {
	const answers: string[] = [];
	page.on("response", async (response) => {
		if (!/\/api\/admin\/(secrets|tenants\/[^/]+\/backups)/.test(response.url())) return;
		answers.push(await response.text().catch(() => ""));
	});
	await signInAs(page, "probe");

	await test.step("secret status", async () => {
		await screen(page, "Secrets");
		await expect(page.getByTestId("secrets-state")).toHaveAttribute("data-state", "ok");
		await page.getByRole("button", { name: "Review rotation" }).click();
		await expect(page.getByTestId("rotation-command")).toHaveText("takebase secrets rotate tenant-a --env staging");
	});

	await test.step("verify the newest backup and review its restore", async () => {
		await screen(page, "Backups");
		const row = page.getByTestId("backup-list").locator("tbody tr[data-backup]").first();
		const backupId = (await row.getAttribute("data-backup")) ?? "";
		await row.getByRole("button", { name: "Verify" }).click();
		await expect(row).toHaveAttribute("data-status", "verified");
		await row.getByRole("button", { name: "Review restore" }).click();
		await expect(page.getByTestId("restore-plan")).toHaveAttribute("data-backup", backupId);
		await expect(page.getByTestId("restore-plan")).toHaveAttribute("data-ready", "true");
		await expect(page.getByTestId("plan-env")).toHaveText("staging");
		await expect(page.getByTestId("plan-database")).toHaveText(/^takebase-staging-restore-/);
	});

	await test.step("no key or envelope in any answer", async () => {
		expect(answers.length).toBeGreaterThanOrEqual(3);
		for (const answer of answers) {
			expect(answer).not.toMatch(/[A-Za-z0-9+/]{43}=/);
			expect(answer).not.toMatch(/"(c|n)":/);
		}
	});

	await test.step("sign out clears it", async () => {
		await page.getByRole("button", { name: "Sign out" }).click();
		await expect(page.getByTestId("sign-in")).toBeVisible();
		await expect(page.locator("body")).not.toContainText("takebase backup restore");
	});
});

test("an agent who is no admin is refused by the staging Workers", async ({ page }) => {
	await signInAs(page, "alice");
	await screen(page, "Backups");
	await expect(page.getByTestId("backups-error")).toHaveText(refused);
	await expect(page.getByTestId("backup-list")).toHaveCount(0);
	await screen(page, "Secrets");
	await expect(page.getByTestId("secrets-error")).toHaveText(refused);

	const { token } = await signIn(users.alice.email, password("alice"));
	const response = await fetch(`${tenantUrl(tenantA)}/api/admin/secrets`, {
		headers: { authorization: `Bearer ${token}` },
	});
	expect(response.status).toBe(403);
});
