import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { type Check, runCollectionContract } from "../../workers/tenant/test/portability-contract.ts";
import { createSqliteD1 } from "./sqlite-adapter.ts";

// The S-7-2-01 native side (SEGU-229): the shared scenario on Bun's SQLite, in
// memory, with nothing kept. `pnpm spike:native`. A feasibility check only: it
// reads no D1 data, and D1 stays the source of truth.

const migrations = (kind: "tenant" | "global") => {
	const dir = new URL(`../../../migrations/${kind}/`, import.meta.url);
	return readdirSync(dir)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => ({
			name,
			queries: readFileSync(new URL(name, dir), "utf8")
				.split("--> statement-breakpoint")
				.filter((query) => query.trim() !== ""),
		}));
};

const open = () => {
	const database = new Database(":memory:");
	// D1 always enforces foreign keys; plain SQLite must be told to.
	database.exec("PRAGMA foreign_keys = ON");
	return database;
};

const tenant = open();
const checks: Check[] = await runCollectionContract(createSqliteD1(tenant), migrations("tenant"));
tenant.close();

// The global schema's triggers parse and run here too; no global code runs.
const global = open();
for (const { queries } of migrations("global")) {
	for (const query of queries) global.exec(query);
}
const now = "2026-10-01T00:00:00.000Z";
global.exec(
	`insert into tenants (id, name, url, status, created, updated) values ('t', 'T', 'https://t.example.test', 'active', '${now}', '${now}')`,
);
global.exec(
	`insert into memberships (id, tenant_id, provider, subject, role, created, updated) values ('m', 't', 'firebase', 'u', 'admin', '${now}', '${now}')`,
);
const revision = global.query("select access_revision as rev from tenants").all()[0]?.rev;
checks.push({
	name: "the global migrations and access trigger run",
	ok: revision === 1,
	detail: `revision ${revision}`,
});
global.close();

const failed = checks.filter(({ ok }) => !ok);
for (const { name, ok, detail } of checks) {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `: ${detail}`}`);
}
const versions = new Database(":memory:");
const sqlite = versions.query("select sqlite_version() as v").all()[0]?.v;
versions.close();
console.log(`Bun ${(process.versions as Record<string, string | undefined>).bun}, SQLite ${sqlite}`);
console.log(
	failed.length === 0 ? `All ${checks.length} native contract checks passed.` : `${failed.length} check(s) failed.`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
