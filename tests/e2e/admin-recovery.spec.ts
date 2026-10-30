/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { catalogText, removeFixtureBackups, writeFixtureBackup } from "../fixtures/recovery-fixture.ts";
import { adminOrigin, password, signIn, tenants, tenantUrl, users } from "../fixtures/tenants.ts";

// S-6-5-01 (SEGU-227): in a real browser against the local stack, an admin
// verifies a fixture backup, reviews a read-only restore plan and sees the
// protected secret status; nobody else gets any of it; sign-out clears it; and
// no key, envelope or backup content reaches the DOM, browser storage or network.

const tenantA = tenantUrl(tenants.find(({ id }) => id === "tenant-a")?.port ?? 0);
const backupsApi = "http://localhost:8787/api/admin/tenants/tenant-a/backups";
const refused = "Only an admin of this tenant may do this";

type Fixture = Awaited<ReturnType<typeof writeFixtureBackup>>;
const fixtures: Fixture[] = [];

const keyValues = () => {
	const text = readFileSync(new URL("../../ops/.local.env", import.meta.url), "utf8");
	return text
		.split("\n")
		.filter((line) => line.startsWith("DATA_KEY_V"))
		.map((line) => line.slice(line.indexOf("=") + 1).trim())
		.filter((value) => value !== "");
};

// The fixtures need this tenant's real migrations and an installed key version.
test.beforeAll(async () => {
	await expect(async () => expect((await fetch(adminOrigin)).ok).toBe(true)).toPass({ timeout: 30_000 });
	const { token } = await signIn(users.carol.email);
	const read = async <T>(path: string) => {
		const response = await fetch(`${tenantA}${path}`, { headers: { authorization: `Bearer ${token}` } });
		expect(response.ok, path).toBe(true);
		return (await response.json()) as T;
	};
	const { migrations } = await read<{ migrations: string[] }>("/api/admin/diagnostics");
	const { activeKeyVersion } = await read<{ activeKeyVersion: number }>("/api/admin/secrets");
	const now = Date.now();
	fixtures.push(await writeFixtureBackup(new Date(now - 60_000), migrations, activeKeyVersion));
	fixtures.push(await writeFixtureBackup(new Date(now), migrations, 99));
});

test.afterAll(async () => {
	await removeFixtureBackups(fixtures);
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
	page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name, exact: true }).click();

// Everything the browser keeps, as text. Firebase's session is in IndexedDB.
const storedText = (page: Page) =>
	page.evaluate(async () => {
		const stores = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
		for (const { name } of await indexedDB.databases()) {
			if (!name) continue;
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const open = indexedDB.open(name);
				open.onsuccess = () => resolve(open.result);
				open.onerror = () => reject(open.error);
			});
			for (const store of db.objectStoreNames) {
				const rows = await new Promise<unknown[]>((resolve, reject) => {
					const all = db.transaction(store).objectStore(store).getAll();
					all.onsuccess = () => resolve(all.result);
					all.onerror = () => reject(all.error);
				});
				stores.push(JSON.stringify(rows));
			}
			db.close();
		}
		return stores.join("\n");
	});

test("an admin verifies a backup, reviews its restore and sees secret status; nothing private stays or leaks", async ({
	page,
}) => {
	const [good, blocked] = fixtures as [Fixture, Fixture];
	const forbidden = [...good.markers, ...blocked.markers, ...keyValues()];
	const answers: string[] = [];
	page.on("response", async (response) => {
		if (!/\/api\/admin\/(secrets|tenants\/[^/]+\/backups)/.test(response.url())) return;
		answers.push(await response.text().catch(() => ""));
	});
	const before = await catalogText();

	await test.step("sign in and read the secret status", async () => {
		await signInAs(page, users.carol.email);
		await selectTenant(page, "Tenant A");
		await screen(page, "Secrets");
		await expect(page.getByTestId("secrets")).toHaveAttribute("data-tenant", "tenant-a");
		await expect(page.getByTestId("secrets-state")).toHaveAttribute("data-state", "ok");
		await page.getByRole("button", { name: "Review rotation" }).click();
		await expect(page.getByTestId("rotation-tenant")).toHaveText("tenant-a");
		await expect(page.getByTestId("rotation-env")).toHaveText("local");
		await expect(page.getByTestId("rotation-command")).toHaveText("takebase secrets rotate tenant-a --env local");
	});

	const row = page.getByTestId("backup-list").locator(`tr[data-backup="${good.backupId}"]`);

	await test.step("verify a fixture backup", async () => {
		await screen(page, "Backups");
		await expect(row).toBeVisible();
		await row.getByRole("button", { name: "Verify" }).click();
		await expect(row).toHaveAttribute("data-status", "verified");
	});

	await test.step("review a read-only restore plan with the exact target", async () => {
		const restoreId = `${good.backupId.toLowerCase()}-tenant-a`;
		await row.getByRole("button", { name: "Review restore" }).click();
		const plan = page.getByTestId("restore-plan");
		await expect(plan).toHaveAttribute("data-backup", good.backupId);
		await expect(plan).toHaveAttribute("data-ready", "true");
		await expect(page.getByTestId("plan-tenant")).toHaveText("tenant-a");
		await expect(page.getByTestId("plan-env")).toHaveText("local");
		await expect(page.getByTestId("plan-database")).toHaveText(`.wrangler/restore-${restoreId}`);
		await expect(page.getByTestId("plan-restore")).toHaveText(
			`takebase backup restore ${good.backupId} --tenant tenant-a --confirm local --env local`,
		);
	});

	await test.step("a key the Worker lacks blocks the plan; pruning is only reviewed", async () => {
		await page
			.getByTestId("backup-list")
			.locator(`tr[data-backup="${blocked.backupId}"]`)
			.getByRole("button", { name: "Review restore" })
			.click();
		await expect(page.getByTestId("restore-plan")).toHaveAttribute("data-backup", blocked.backupId);
		await expect(page.getByTestId("restore-plan")).toHaveAttribute("data-ready", "false");
		await expect(page.getByTestId("plan-problems")).toContainText("data key v99 is not installed");
		await page.getByRole("button", { name: "Review pruning" }).click();
		await expect(page.getByTestId("prune-command")).toHaveText("takebase backup prune --keep <n> --plan --env local");
		// The page only reads: no control restores, prunes or rotates.
		for (const name of [/^restore$/i, /^prune$/i, /^rotate$/i, /^confirm$/i]) {
			await expect(page.getByRole("button", { name })).toHaveCount(0);
		}
	});

	await test.step("no key, envelope or backup content reached the browser", async () => {
		const seen = [await page.content(), await storedText(page), ...answers];
		expect(answers.length).toBeGreaterThanOrEqual(4);
		for (const text of seen) {
			for (const value of forbidden) expect(text).not.toContain(value);
		}
		for (const answer of answers) expect(answer).not.toMatch(/[A-Za-z0-9+/]{43}=/);
		expect(await catalogText()).toBe(before);
	});

	await test.step("another tenant's screens refuse a member who is no admin there", async () => {
		await selectTenant(page, "Tenant B");
		await expect(page.getByTestId("backups")).toHaveAttribute("data-tenant", "tenant-b");
		await expect(page.getByTestId("backups-error")).toHaveText(refused);
		await expect(page.getByTestId("backup-list")).toHaveCount(0);
		await expect(page.getByTestId("restore-plan")).toHaveCount(0);
		await screen(page, "Secrets");
		await expect(page.getByTestId("secrets-error")).toHaveText(refused);
	});

	await test.step("sign out clears the private metadata", async () => {
		await selectTenant(page, "Tenant A");
		await screen(page, "Backups");
		await expect(row).toBeVisible();
		await page.getByRole("button", { name: "Sign out" }).click();
		await expect(page.getByTestId("sign-in")).toBeVisible();
		const body = page.locator("body");
		await expect(body).not.toContainText(good.backupId);
		await expect(body).not.toContainText("takebase backup restore");
		for (const value of [good.backupId, blocked.backupId]) expect(await storedText(page)).not.toContain(value);
	});
});

test("a member who is no admin is refused by the Workers, in the admin and directly", async ({ page }) => {
	const [good] = fixtures as [Fixture];
	await signInAs(page, users.bob.email);
	await selectTenant(page, "Tenant A");
	await screen(page, "Backups");
	await expect(page.getByTestId("backups-error")).toHaveText(refused);
	await expect(page.getByTestId("backup-list")).toHaveCount(0);
	await screen(page, "Secrets");
	await expect(page.getByTestId("secrets-error")).toHaveText(refused);
	await expect(page.getByTestId("secrets-state")).toHaveCount(0);

	const { token } = await signIn(users.bob.email);
	const authorization = `Bearer ${token}`;
	for (const [method, url] of [
		["GET", backupsApi],
		["POST", `${backupsApi}/${good.backupId}/verify`],
		["GET", `${backupsApi}/${good.backupId}/restore-plan`],
		["GET", `${tenantA}/api/admin/secrets`],
	] as const) {
		expect((await fetch(url, { method, headers: { authorization } })).status, url).toBe(403);
	}
});
