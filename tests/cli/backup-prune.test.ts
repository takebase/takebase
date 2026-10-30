import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backupCommand } from "../../packages/cli/src/commands/backup.ts";
import { catalogKey, parseCatalog } from "../../packages/cli/src/services/backup-manifest.ts";
import { executePrune, planPrune } from "../../packages/cli/src/services/backup-prune.ts";
import { type CapturedPart, commitBackup, listBackups } from "../../packages/cli/src/services/backups.ts";
import { account, backupProject, cliIo, exportSql, fakeCloudflare } from "../fixtures/backup-cloudflare.ts";
import { memoryStore } from "../fixtures/backup-store.ts";
import { randomValue } from "../fixtures/secret-store.ts";

// R-6-4-01 (SEGU-226): prune never removes a protected backup, deletes only
// with --confirm, and an interrupted prune never leaves the catalog listing a
// backup whose objects are gone.

const encode = (text: string) => new TextEncoder().encode(text);
const parts = (): CapturedPart[] => [
	{
		kind: "d1",
		target: "global",
		database: "takebase-global",
		capturedAt: "2026-10-28T12:00:00.000Z",
		schemaVersion: "0000_tenants.sql",
		migrations: [{ name: "0000_tenants.sql", sha256: null }],
		file: "global/d1.sql",
		bytes: encode(exportSql(["0000_tenants.sql"], "tenants")),
	},
	{
		kind: "config",
		target: "environment",
		capturedAt: "2026-10-28T12:00:00.000Z",
		file: "config.json",
		bytes: encode("{}\n"),
	},
];

// Backups an hour apart, oldest first: e.g. ["global", "all", "global"].
const backups = async (subjects: string[]) => {
	const { objects, store } = memoryStore();
	const ids: string[] = [];
	for (const [i, subject] of subjects.entries()) {
		const created = new Date(Date.UTC(2026, 9, 28, i));
		const scope = subject.startsWith("tenant-") ? "tenant" : (subject as "global" | "all");
		const tenantId = scope === "tenant" ? subject.slice("tenant-".length) : undefined;
		ids.push(
			(await commitBackup(store, { created, environment: "local", scope, tenantId, cliVersion: "0" }, parts()))
				.backupId,
		);
	}
	return { objects, store, ids };
};

describe("takebase backup prune (R-6-4-01)", () => {
	it("keeps the newest verified per subject, restores' backups, and drops FAILED ones from the count", async () => {
		const { objects, store, ids } = await backups(["global", "global", "global", "all", "all", "global"]);
		// The newest global backup is damaged: the one before it is the newest verified.
		objects.delete(`backups/${ids[5]}/config.json`);
		const decisions = await planPrune(store, 1, new Set([ids[0] ?? ""]));
		const action = Object.fromEntries(
			decisions.map(({ entry, action, reason }) => [entry.backupId, `${action}: ${reason}`]),
		);
		expect(action).toEqual({
			[ids[5] ?? ""]: "delete: FAILED verification",
			[ids[4] ?? ""]: "keep: newest verified all backup",
			[ids[3] ?? ""]: "delete: older than the 1 newest verified all backups",
			[ids[2] ?? ""]: "keep: newest verified global backup",
			[ids[1] ?? ""]: "delete: older than the 1 newest verified global backups",
			[ids[0] ?? ""]: "keep: a recorded restore refers to it",
		});
		await expect(planPrune(store, 0, new Set())).rejects.toThrow("--keep must be a whole number of at least 1");
	});

	it("deletes the objects of pruned backups only, and the rest still verify", async () => {
		const { objects, store, ids } = await backups(["global", "global", "global"]);
		await executePrune(store, await planPrune(store, 2, new Set()), () => {});
		expect([...objects.keys()].some((key) => key.includes(ids[0] ?? "-"))).toBe(false);
		const left = await listBackups(store);
		expect(left.map(({ entry }) => entry.backupId)).toEqual([ids[2], ids[1]]);
		expect(left.every(({ verification }) => verification.status === "verified")).toBe(true);
	});

	it("never lists a backup whose objects are gone when a prune is interrupted, and finishes it next time", async () => {
		const { objects, store, ids } = await backups(["global", "global", "global"]);
		const decisions = await planPrune(store, 1, new Set());
		let deletes = 0;
		const failing = {
			...store,
			delete: async (key: string) => {
				if (++deletes === 2) throw new Error("connection reset");
				await store.delete(key);
			},
		};
		await expect(executePrune(failing, decisions, () => {})).rejects.toThrow("connection reset");
		const listed = await listBackups(store);
		expect(listed.map(({ entry }) => entry.backupId)).toEqual([ids[2]]);
		expect(listed.every(({ verification }) => verification.status === "verified")).toBe(true);
		const catalog = parseCatalog(new TextDecoder().decode(objects.get(catalogKey)));
		expect(catalog.pruning?.length).toBe(2);
		// The next prune (nothing new to delete) finishes the interrupted one.
		await executePrune(store, await planPrune(store, 1, new Set()), () => {});
		expect(parseCatalog(new TextDecoder().decode(objects.get(catalogKey))).pruning).toBeUndefined();
		expect([...objects.keys()].filter((key) => key !== catalogKey).every((key) => key.includes(ids[2] ?? "-"))).toBe(
			true,
		);
	});

	it("deletes only with --confirm naming the environment; --plan changes nothing", async () => {
		const root = mkdtempSync(join(tmpdir(), "takebase-prune-"));
		try {
			backupProject(root, "takebase-staging-backups", {
				CLOUDFLARE_ACCOUNT_ID: account,
				FIREBASE_API_KEY: randomValue(),
			});
			const cf = fakeCloudflare({ "staging-tenant-a": new Map(), "staging-tenant-b": new Map() });
			const run = async (...args: string[]) => {
				const out = cliIo(root);
				try {
					return { code: await backupCommand([...args, "--env", "staging"], out.io, cf.deps), text: out.text() };
				} catch (error) {
					return { code: 1, text: `${out.text()}${error instanceof Error ? error.message : String(error)}` };
				}
			};
			for (let i = 0; i < 2; i++) {
				expect((await run("create", "--global")).code).toBe(0);
				await new Promise((resolve) => setTimeout(resolve, 1_050));
			}
			const before = new Map(cf.r2);
			const plan = await run("prune", "--keep", "1", "--plan");
			expect(plan.code, plan.text).toBe(0);
			expect(plan.text).toMatch(/DELETE \d{8}T\d{6}Z-global +older than the 1 newest verified global backups/);
			expect(plan.text).toContain("Plan only: 1 backup(s) would be deleted; nothing was changed.");
			expect(cf.r2).toEqual(before);
			const wrong = await run("prune", "--keep", "1", "--confirm", "local");
			expect(wrong.text).toContain('--confirm local does not name environment "staging"');
			expect(cf.r2).toEqual(before);
			const done = await run("prune", "--keep", "1", "--confirm", "staging");
			expect(done.code, done.text).toBe(0);
			expect(done.text).toContain("Pruned 1 backup(s)");
			expect((await run("list")).text.match(/ verified\n/g)).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
