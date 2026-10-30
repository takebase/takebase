import { env, exports } from "cloudflare:workers";
import type {
	BackupManifest,
	BackupPart,
	TenantBackupCheck,
	TenantBackupList,
	TenantRestorePlan,
} from "@takebase/contracts";
import { describe, expect, it } from "vitest";
import { addMember, addTenant, emulatorToken } from "./fixtures.ts";

// SEGU-227 (R-6-5-01, security): a tenant's admins read only their own
// tenant's backups, as metadata, and verify them without the Worker writing
// to the bucket or answering with another tenant's parts or any object bytes.

const call = (path: string, user: string | null, method = "GET") =>
	exports.default.fetch(`https://global.local/api/admin/tenants${path}`, {
		method,
		headers: user === null ? {} : { authorization: `Bearer ${emulatorToken(user)}` },
	});

const hex = (buffer: ArrayBuffer) =>
	[...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
};
const base64url = (length: number) =>
	btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(length))))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");

// A ciphertext envelope as KV holds it: random bytes, assembled at runtime.
const envelope = (kv: number) => JSON.stringify({ v: 1, alg: "A256GCM", kv, n: base64url(12), c: base64url(40) });

// Writes one backup the way the CLI does: objects, then the sealed manifest.
const writeBackup = async (backupId: string, scope: BackupManifest["scope"], contents: Record<string, string>) => {
	const parts: BackupPart[] = [];
	for (const [target, text] of Object.entries(contents)) {
		const [kind, owner = ""] = target.split("@") as ["d1" | "kv" | "config", string?];
		const key = `backups/${backupId}/${kind}-${owner || "environment"}.${kind === "d1" ? "sql" : "json"}`;
		await env.BACKUPS.put(key, text);
		const object = { key, bytes: new TextEncoder().encode(text).byteLength, sha256: await sha256(text) };
		const capturedAt = "2026-10-30T00:00:00.000Z";
		if (kind === "d1") {
			const migrations = [{ name: "0001_init.sql", sha256: null }];
			parts.push({
				kind,
				target: owner,
				database: `db-${owner}`,
				capturedAt,
				schemaVersion: "0001_init.sql",
				migrations,
				object,
			});
		} else if (kind === "kv") {
			parts.push({
				kind,
				target: owner,
				binding: "SECRETS",
				capturedAt,
				count: text.split("\n").filter(Boolean).length,
				keyVersions: [2],
				object,
			});
		} else {
			parts.push({ kind, target: "environment", capturedAt, object });
		}
	}
	const draft = {
		format: "takebase-backup" as const,
		version: 1 as const,
		backupId,
		created: `${backupId.slice(0, 4)}-10-30T00:00:00.000Z`,
		environment: "local",
		scope,
		cliVersion: "0.0.0",
		parts,
	};
	const manifestSha256 = await sha256(canonicalJson(draft));
	await env.BACKUPS.put(`backups/${backupId}/manifest.json`, JSON.stringify({ ...draft, manifestSha256 }));
	return manifestSha256;
};

const listing = async () => (await env.BACKUPS.list()).objects.map(({ key, etag }) => `${key}:${etag}`).sort();

describe("tenant backups for admins (SEGU-227)", () => {
	it("are read only by that tenant's admins, as this tenant's metadata, and verified without writes", async () => {
		await addTenant("acme");
		await addTenant("globex");
		await addMember("acme", "ada", "admin");
		await addMember("acme", "bob", "agent");
		await addMember("globex", "carol", "admin");

		const globexRow = `globex-only-${crypto.randomUUID()}`;
		const all = await writeBackup("20261030T000000Z-all", "all", {
			"d1@global": "create table tenants (id text);",
			"d1@tenant:acme": "create table policies (id text);",
			"kv@tenant:acme": `${JSON.stringify({ name: "secret/app/smtp", value: envelope(2) })}\n`,
			"d1@tenant:globex": `insert into policies values ('${globexRow}');`,
			"config@": JSON.stringify({
				environment: { name: "local", remote: false, namePrefix: null, tenants: [{ id: "acme" }, { id: "globex" }] },
				workers: { tenants: { acme: { vars: { TENANT_ID: "acme" } } } },
			}),
		});
		const globexOnly = await writeBackup("20261030T010000Z-tenant-globex", "tenant", {
			"d1@tenant:globex": "create table policies (id text);",
		});
		await env.BACKUPS.put(
			"backups/catalog.json",
			JSON.stringify({
				version: 1,
				backups: [
					{ backupId: "20261030T000000Z-all", created: "2026-10-30T00:00:00.000Z", scope: "all", manifestSha256: all },
					{
						backupId: "20261030T010000Z-tenant-globex",
						created: "2026-10-30T01:00:00.000Z",
						scope: "tenant",
						manifestSha256: globexOnly,
					},
				],
			}),
		);
		const before = await listing();

		for (const [user, status] of [
			[null, 401],
			["bob", 403],
			["carol", 403],
		] as const) {
			expect((await call("/acme/backups", user)).status).toBe(status);
			expect((await call("/acme/backups/20261030T000000Z-all/verify", user, "POST")).status).toBe(status);
		}
		expect((await call("/initech/backups", "ada")).status).toBe(403);

		const listed = await call("/acme/backups", "ada");
		expect(listed.status).toBe(200);
		const text = await listed.text();
		for (const forbidden of ["globex", globexRow, "backups/", "sha256", "tenants (id"])
			expect(text).not.toContain(forbidden);
		expect(JSON.parse(text) as TenantBackupList).toEqual({
			backups: [
				{
					backupId: "20261030T000000Z-all",
					created: "2026-10-30T00:00:00.000Z",
					scope: "all",
					environment: "local",
					parts: [
						{ kind: "d1", capturedAt: "2026-10-30T00:00:00.000Z", bytes: 32 },
						{ kind: "kv", capturedAt: "2026-10-30T00:00:00.000Z", bytes: expect.any(Number) },
					],
					schemaVersion: "0001_init.sql",
					migrations: ["0001_init.sql"],
					keyVersions: [2],
				},
			],
		});

		const verified = await call("/acme/backups/20261030T000000Z-all/verify", "ada", "POST");
		expect((await verified.json()) as TenantBackupCheck).toMatchObject({ status: "verified", problems: [] });
		// Another tenant's backup and a malformed id look like an unknown one.
		expect((await call("/acme/backups/20261030T010000Z-tenant-globex/verify", "ada", "POST")).status).toBe(404);
		expect((await call("/acme/backups/..%2Fcatalog.json/verify", "ada", "POST")).status).toBe(404);
		expect(await listing()).toEqual(before);

		// The restore review names the exact isolated target and the operator's commands.
		for (const [user, status] of [
			[null, 401],
			["bob", 403],
			["carol", 403],
		] as const) {
			expect((await call("/acme/backups/20261030T000000Z-all/restore-plan", user)).status).toBe(status);
		}
		expect((await call("/acme/backups/20261030T010000Z-tenant-globex/restore-plan", "ada")).status).toBe(404);
		const planned = await call("/acme/backups/20261030T000000Z-all/restore-plan", "ada");
		const planText = await planned.text();
		for (const forbidden of ["globex", globexRow, "sha256"]) expect(planText).not.toContain(forbidden);
		expect(JSON.parse(planText) as TenantRestorePlan).toMatchObject({
			tenantId: "acme",
			environment: "local",
			restoreId: "20261030t000000z-all-acme",
			target: { database: ".wrangler/restore-20261030t000000z-all-acme" },
			secrets: 1,
			keyVersions: [2],
			problems: [],
			commands: {
				dryRun: "takebase backup restore 20261030T000000Z-all --tenant acme --dry-run --env local",
				restore: "takebase backup restore 20261030T000000Z-all --tenant acme --confirm local --env local",
			},
		});
		expect(await listing()).toEqual(before);

		// A changed tenant object fails the check.
		await env.BACKUPS.put("backups/20261030T000000Z-all/d1-tenant:acme.sql", "create table policies (id text);  ");
		const tampered = (await (
			await call("/acme/backups/20261030T000000Z-all/verify", "ada", "POST")
		).json()) as TenantBackupCheck;
		expect(tampered.status).toBe("failed");
		expect(tampered.problems).toEqual(["d1 export: 34 bytes, expected 32 (truncated or altered)"]);
	});
});
