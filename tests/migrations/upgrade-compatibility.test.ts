import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

// R-7-2-01: an existing database keeps its rows through every released migration,
// and the invariants hold on those older rows. Runs on SQLite, D1's engine; the
// D1 side of the tenant migrations is in the tenant Worker's portability test.

const steps = (kind: "tenant" | "global") => {
	const dir = new URL(`../../migrations/${kind}/`, import.meta.url);
	return readdirSync(dir)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => readFileSync(new URL(name, dir), "utf8").split("--> statement-breakpoint"));
};

const database = () => {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	return db;
};
const apply = (db: DatabaseSync, step: string[] | undefined) => {
	for (const statement of step ?? []) db.exec(statement);
};
const now = "2026-10-01T00:00:00.000Z";

describe("migration upgrades (R-7-2-01)", () => {
	it("keeps tenant records through every tenant migration", () => {
		const db = database();
		const [first, ...rest] = steps("tenant");
		apply(db, first);
		db.exec(`insert into agents (id, name) values ('agent-1', 'Agent')`);
		db.exec(
			`insert into policies (id, number, holder, status, agent_id, premium, created, updated) values ('policy-1', 'OLD-1', 'Holder', 'active', 'agent-1', 10, '${now}', '${now}')`,
		);
		for (const step of rest) apply(db, step);
		expect(db.prepare("select number, agent_id, premium from policies").all()).toEqual([
			{ number: "OLD-1", agent_id: "agent-1", premium: 10 },
		]);
		db.exec(
			`insert into takebase_outbox (id, collection, operation, record_id, created, available_at) values ('event-1', 'policies', 'update', 'policy-1', '${now}', '${now}')`,
		);
		expect(db.prepare("select status, attempts from takebase_outbox").get()).toEqual({
			status: "pending",
			attempts: 0,
		});
	});

	it("keeps tenants and members through every global migration, and protects them afterwards", () => {
		const db = database();
		const [first, ...rest] = steps("global");
		apply(db, first);
		db.exec(
			`insert into tenants (id, name, url, status, created, updated) values ('old', 'Old', 'https://old.example.test', 'active', '${now}', '${now}')`,
		);
		for (const [id, subject, role] of [
			["m-1", "owner", "admin"],
			["m-2", "worker", "agent"],
		]) {
			db.exec(
				`insert into memberships (id, tenant_id, provider, subject, role, created, updated) values ('${id}', 'old', 'firebase', '${subject}', '${role}', '${now}', '${now}')`,
			);
		}
		for (const step of rest) apply(db, step);

		const revision = () =>
			(db.prepare("select access_revision as rev from tenants where id = 'old'").get() as { rev: number }).rev;
		expect(db.prepare("select subject, role from memberships order by id").all()).toEqual([
			{ subject: "owner", role: "admin" },
			{ subject: "worker", role: "agent" },
		]);
		// The roles already in use were declared, so they stay usable.
		expect(db.prepare("select name from tenant_roles where tenant_id = 'old' order by name").all()).toEqual([
			{ name: "admin" },
			{ name: "agent" },
		]);
		expect(revision()).toBe(0);
		db.exec(
			`insert into memberships (id, tenant_id, provider, subject, role, created, updated) values ('m-3', 'old', 'firebase', 'new', 'agent', '${now}', '${now}')`,
		);
		expect(revision()).toBe(1);
		// A member who joined before the invariants existed is covered by them.
		expect(() => db.exec("delete from memberships where id = 'm-1'")).toThrow("at least one admin");
		expect(() => db.exec("update tenants set access_revision = 0 where id = 'old'")).toThrow("never decreases");
		// Removing a member still owes a revocation, newer than any grant so far.
		db.exec("delete from memberships where id = 'm-2'");
		expect(db.prepare("select subject, rev from member_revocations").all()).toEqual([
			{ subject: "worker", rev: revision() },
		]);
	});
});
