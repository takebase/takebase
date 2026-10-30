import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupCommand } from "../../packages/cli/src/commands/backup.ts";
import { account, backupProject, cliIo, fakeCloudflare, secretsKv } from "../fixtures/backup-cloudflare.ts";
import { randomKey, randomValue } from "../fixtures/secret-store.ts";

// `takebase backup create|list|verify` (SEGU-225) on a throwaway remote
// project with a fake Wrangler (tests/fixtures/backup-cloudflare.ts). It
// proves coverage, account pinning and that nothing secret is written or
// printed.

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "takebase-backup-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("takebase backup create (S-6-3-01 coverage)", () => {
	it("backs up a tenant, the global database and everything, each with matching manifest coverage", async () => {
		const secrets = { CLOUDFLARE_ACCOUNT_ID: account, FIREBASE_API_KEY: randomValue() };
		backupProject(root, "takebase-staging-backups", secrets);
		const cf = fakeCloudflare({
			"staging-tenant-a": await secretsKv(randomKey(), [randomValue(), randomValue(), randomValue()]),
			"staging-tenant-b": new Map(),
		});
		const run = async (...args: string[]) => {
			const out = cliIo(root);
			const code = await backupCommand([...args, "--env", "staging"], out.io, cf.deps);
			return { code, text: out.text() };
		};
		const manifests = [];
		for (const selection of [["--tenant", "tenant-a"], ["--global"], ["--all"]]) {
			const created = await run("create", ...selection);
			expect(created.code, created.text).toBe(0);
			expect(created.text).toMatch(/: verified\n$/);
			const key = [...cf.r2.keys()].filter((name) => name.endsWith("/manifest.json")).at(-1) ?? "";
			manifests.push(JSON.parse(String(cf.r2.get(key))));
			// Backup ids have one-second resolution.
			await new Promise((resolve) => setTimeout(resolve, 1_050));
		}
		const coverage = (manifest: {
			parts: {
				kind: string;
				target: string;
				schemaVersion?: string;
				count?: number;
				keyVersions?: number[];
				migrations?: { sha256: string | null }[];
			}[];
		}) =>
			manifest.parts.map(({ kind, target, schemaVersion, count, keyVersions, migrations }) => ({
				kind,
				target,
				schemaVersion,
				count,
				keyVersions,
				hashed: migrations?.every((migration) => migration.sha256 !== null),
			}));
		const tenantA = [
			{ kind: "d1", target: "tenant:tenant-a", schemaVersion: "0000_policies.sql", hashed: true },
			{ kind: "kv", target: "tenant:tenant-a", count: 3, keyVersions: [2] },
		];
		const global = { kind: "d1", target: "global", schemaVersion: "0001_access.sql", hashed: true };
		const config = { kind: "config", target: "environment" };
		expect(manifests.map((manifest) => [manifest.scope, coverage(manifest)])).toEqual([
			["tenant", [...tenantA, config]],
			["global", [global, config]],
			[
				"all",
				[
					global,
					...tenantA,
					{ kind: "d1", target: "tenant:tenant-b", schemaVersion: "0000_policies.sql", hashed: true },
					{ kind: "kv", target: "tenant:tenant-b", count: 0, keyVersions: [] },
					config,
				],
			],
		]);
		const listed = await run("list");
		expect(listed.code).toBe(0);
		expect(listed.text.match(/ verified\n/g)).toHaveLength(3);
		// Every Wrangler call is pinned to the environment's account.
		expect(cf.calls.every(({ env }) => env?.CLOUDFLARE_ACCOUNT_ID === account)).toBe(true);
	});

	it("writes and prints no data key, secrets-file value, password or plaintext secret", async () => {
		const dataKey = randomKey();
		const password = randomValue();
		const plaintexts = [randomValue(), randomValue()];
		const secrets = {
			CLOUDFLARE_ACCOUNT_ID: account,
			FIREBASE_API_KEY: randomValue(),
			PASSWORD_DISPATCHER_TENANT_A: password,
			DATA_KEY_V2_TENANT_A: dataKey,
		};
		backupProject(root, "takebase-staging-backups", secrets);
		const cf = fakeCloudflare({ "staging-tenant-a": await secretsKv(dataKey, plaintexts) });
		const out = cliIo(root);
		expect(await backupCommand(["create", "--all", "--env", "staging"], out.io, cf.deps)).toBe(0);
		const everything = [...[...cf.r2.values()].map(String), out.text()].join("\n");
		expect(everything).toContain("A256GCM");
		for (const value of [
			...Object.values(secrets),
			...plaintexts,
			Buffer.from(dataKey, "base64").toString("base64url"),
		]) {
			expect(everything).not.toContain(value);
		}
		expect(everything).not.toContain("secrets.env");
	});

	it("refuses a bucket outside the environment's name prefix before any Cloudflare call", async () => {
		backupProject(root, "other-project-backups", { CLOUDFLARE_ACCOUNT_ID: account, FIREBASE_API_KEY: randomValue() });
		const cf = fakeCloudflare({});
		const out = cliIo(root);
		await expect(backupCommand(["init", "--env", "staging"], out.io, cf.deps)).rejects.toThrow(
			'Refusing to touch R2 bucket "other-project-backups"',
		);
		expect(cf.calls).toEqual([]);
	});

	it("documents the consistency limits and the exclusions", () => {
		const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
		const section = readme.slice(readme.indexOf("### Backups"), readme.indexOf("### Dev, build and deploy"));
		expect(section).toContain("**not** one atomic snapshot");
		expect(section).toContain("Firebase Auth");
		expect(section).toContain("Realtime Database notifications");
		expect(section).toMatch(/escrow/);
		expect(section).toContain("Time Travel");
	});
});
