import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	type AdminDeps,
	addMember,
	changeUser,
	createInvite,
	createRole,
	deleteRole,
	deliverRevocations,
	listInvites,
	listMembers,
	listUsers,
	removeMember,
	revokeInvite,
	tokenHash,
} from "../../packages/cli/src/services/administration.ts";

// Global D1 stand-in: SQLite with the real migrations/global, so the role,
// last-admin, revocation and audit triggers are the deployed ones (R-5-2-01).
// `before` runs after the migrations that predate SEGU-220, so the back-fill
// of 0005/0006 is exercised on existing data as on staging.

const now = "2026-10-26T00:00:00.000Z";
const dir = new URL("../../migrations/global/", import.meta.url);
const files = readdirSync(dir)
	.filter((name) => name.endsWith(".sql"))
	.sort();

const globalDatabase = (before: (db: DatabaseSync) => void = () => {}) => {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	const apply = (names: string[]) => {
		for (const name of names)
			for (const statement of readFileSync(new URL(name, dir), "utf8").split("--> statement-breakpoint"))
				db.exec(statement);
	};
	const firstNew = files.findIndex((name) => name.startsWith("0005_"));
	apply(files.slice(0, firstNew));
	before(db);
	apply(files.slice(firstNew));
	return db;
};

const tenant = (db: DatabaseSync, id: string) =>
	db.exec(
		`insert into tenants (id, name, url, status, created, updated) values ('${id}', '${id}', 'https://${id}.test', 'active', '${now}', '${now}')`,
	);
const member = (db: DatabaseSync, tenantId: string, subject: string, role: string) =>
	db.exec(
		`insert into memberships (id, tenant_id, provider, subject, role, created, updated) values ('${crypto.randomUUID()}', '${tenantId}', 'firebase', '${subject}', '${role}', '${now}', '${now}')`,
	);
const declare = (db: DatabaseSync, tenantId: string, role: string) =>
	db.exec(`insert into tenant_roles (tenant_id, name, created) values ('${tenantId}', '${role}', '${now}')`);
const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all();
const revision = (db: DatabaseSync, id: string) =>
	(db.prepare(`select access_revision as rev from tenants where id = '${id}'`).get() as { rev: number }).rev;
const revocations = (db: DatabaseSync) =>
	rows(db, "select tenant_id, subject, rev from member_revocations order by tenant_id, subject, rev");

describe("administration invariants in global D1 (R-5-2-01)", () => {
	it("declares admin and every existing role, and refuses undeclared roles", () => {
		const db = globalDatabase((old) => {
			tenant(old, "acme");
			member(old, "acme", "alice", "agent");
			member(old, "acme", "bob", "member");
		});
		expect(rows(db, "select name from tenant_roles where tenant_id = 'acme' order by name")).toEqual([
			{ name: "admin" },
			{ name: "agent" },
			{ name: "member" },
		]);
		tenant(db, "globex");
		expect(rows(db, "select name from tenant_roles where tenant_id = 'globex'")).toEqual([{ name: "admin" }]);

		expect(() => member(db, "globex", "alice", "agent")).toThrow(/role is not declared/);
		expect(() => db.exec("update memberships set role = 'owner' where subject = 'alice'")).toThrow(
			/role is not declared/,
		);
		expect(() =>
			db.exec(
				`insert into invitations (id, tenant_id, role, token_hash, created_by, expires, created) values ('i1', 'globex', 'agent', 'h', 'operator', '${now}', '${now}')`,
			),
		).toThrow(/role is not declared/);
		expect(() => db.exec("delete from tenant_roles where tenant_id = 'globex' and name = 'admin'")).toThrow(/built in/);
		expect(() => db.exec("delete from tenant_roles where tenant_id = 'acme' and name = 'agent'")).toThrow(
			/still assigned/,
		);
	});

	it("never leaves a tenant without its last admin, except when the tenant itself is deleted", () => {
		const db = globalDatabase();
		tenant(db, "acme");
		declare(db, "acme", "agent");
		member(db, "acme", "alice", "admin");
		member(db, "acme", "alice", "agent");
		expect(() => db.exec("delete from memberships where subject = 'alice' and role = 'admin'")).toThrow(
			/at least one admin/,
		);
		expect(() => db.exec("update memberships set role = 'agent' where role = 'admin'")).toThrow(/at least one admin/);
		// Removing every role of the last admin at once is refused too.
		expect(() => db.exec("delete from memberships where subject = 'alice'")).toThrow(/at least one admin/);

		member(db, "acme", "bob", "admin");
		db.exec("delete from memberships where subject = 'alice' and role = 'admin'");
		expect(rows(db, "select subject from memberships where role = 'admin'")).toEqual([{ subject: "bob" }]);

		db.exec("delete from tenants where id = 'acme'");
		expect(rows(db, "select count(*) as n from memberships union all select count(*) from tenant_roles")).toEqual([
			{ n: 0 },
			{ n: 0 },
		]);
	});

	it("records a realtime revocation newer than any grant when access ends", () => {
		const db = globalDatabase();
		tenant(db, "acme");
		tenant(db, "globex");
		declare(db, "acme", "agent");
		declare(db, "acme", "member");
		declare(db, "globex", "agent");
		member(db, "acme", "alice", "agent");
		member(db, "acme", "alice", "member");
		member(db, "globex", "alice", "agent");
		member(db, "acme", "bob", "agent");

		// Losing one of two roles keeps the membership: nothing to revoke.
		db.exec("delete from memberships where subject = 'alice' and tenant_id = 'acme' and role = 'member'");
		expect(revocations(db)).toEqual([]);

		// Losing the last role: revoked at the revision this removal produced.
		const granted = revision(db, "acme");
		db.exec("delete from memberships where subject = 'bob'");
		expect(revocations(db)).toEqual([{ tenant_id: "acme", subject: "bob", rev: granted + 1 }]);
		expect(revision(db, "acme")).toBe(granted + 1);

		// Disabling an identity revokes it in every tenant it belongs to, above the old revisions.
		const [acme, globex] = [revision(db, "acme"), revision(db, "globex")];
		db.exec(
			`insert into identities (provider, subject, status, created, updated) values ('firebase', 'alice', 'disabled', '${now}', '${now}')`,
		);
		expect(revocations(db)).toContainEqual({ tenant_id: "acme", subject: "alice", rev: acme + 1 });
		expect(revocations(db)).toContainEqual({ tenant_id: "globex", subject: "alice", rev: globex + 1 });
		// A fresh sign-in is granted at the current revision, which must outrank the revocation.
		expect(revision(db, "acme")).toBeGreaterThan(acme + 1);
		expect(revision(db, "globex")).toBeGreaterThan(globex + 1);

		// Re-enabling grants nothing by itself; revoking sessions revokes again.
		db.exec("update identities set status = 'active' where subject = 'alice'");
		expect(revocations(db)).toHaveLength(3);
		db.exec("update identities set sessions_valid_after = 1793000000 where subject = 'alice'");
		expect(revocations(db)).toHaveLength(5);
		expect(Math.min(...revocations(db).map(({ rev }) => Number(rev)))).toBeGreaterThan(0);
	});

	it("keeps audit events append-only", () => {
		const db = globalDatabase();
		db.exec(`insert into audit_events (id, created, actor, action) values ('e1', '${now}', 'operator', 'role.create')`);
		expect(() => db.exec("update audit_events set actor = 'someone-else'")).toThrow(/append-only/);
		expect(() => db.exec("delete from audit_events")).toThrow(/append-only/);
	});
});

// The operator CLI's administration service against the same schema. Several
// statements run as one transaction, as D1 runs a batch; the tenant Workers
// are scripted: `reachable` decides whether reconcile delivers.
const operator = (db: DatabaseSync, reachable: () => boolean = () => true) => {
	let clock = new Date("2026-10-26T01:00:00.000Z");
	const deps: AdminDeps = {
		query: (sql) => {
			const statements = sql.split(";\n");
			if (statements.length === 1) return db.prepare(sql).all() as Record<string, unknown>[];
			db.exec("BEGIN");
			try {
				for (const statement of statements) db.exec(statement);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
			return [];
		},
		reconcile: async (url) => {
			if (!reachable()) return 0;
			// What the tenant Worker does: revoke each owed user, then confirm.
			db.prepare(
				"update member_revocations set confirmed = 'now' where confirmed is null and tenant_id = (select id from tenants where url = ?)",
			).run(url);
			return 200;
		},
		wait: async () => {},
		now: () => clock,
	};
	return { deps, advance: (hours: number) => (clock = new Date(clock.getTime() + hours * 3_600_000)) };
};
const auditActions = (db: DatabaseSync) => rows(db, "select action from audit_events order by created, action");

describe("operator administration (R-5-2-01, CLI service)", () => {
	it("audits every change, and a refused change leaves nothing behind", () => {
		const db = globalDatabase();
		tenant(db, "acme");
		const { deps } = operator(db);
		createRole(deps, "acme", "agent");
		addMember(deps, "acme", "alice", "admin");
		addMember(deps, "acme", "alice", "agent");
		expect(listMembers(deps, "acme")).toEqual([{ subject: "alice", roles: "admin, agent", status: "active" }]);

		expect(() => addMember(deps, "acme", "bob", "boss")).toThrow(/not declared/);
		expect(() => removeMember(deps, "acme", "alice", "admin")).toThrow(/last admin/);
		expect(() => removeMember(deps, "acme", "alice")).toThrow(/last admin/);
		expect(() => deleteRole(deps, "acme", "agent")).toThrow(/still assigned/);
		expect(() => addMember(deps, "no-such-tenant", "bob", "agent")).toThrow(/not registered/);
		expect(listMembers(deps, "acme")).toHaveLength(1);
		expect(auditActions(db)).toEqual([{ action: "member.add" }, { action: "member.add" }, { action: "role.create" }]);
	});

	it("ending access revokes realtime in every tenant, retried until delivered", async () => {
		const db = globalDatabase();
		tenant(db, "acme");
		tenant(db, "globex");
		let up = false;
		const { deps } = operator(db, () => up);
		for (const id of ["acme", "globex"]) createRole(deps, id, "agent");
		addMember(deps, "acme", "alice", "agent");
		addMember(deps, "globex", "alice", "agent");
		addMember(deps, "acme", "bob", "agent");

		expect(changeUser(deps, "alice", "disable")).toBe(true);
		expect(await deliverRevocations(deps, "alice", { attempts: 2 })).toEqual([
			{ tenant: "acme", delivered: false, attempts: 2 },
			{ tenant: "globex", delivered: false, attempts: 2 },
		]);
		up = true;
		expect(await deliverRevocations(deps, "alice")).toEqual([
			{ tenant: "acme", delivered: true, attempts: 1 },
			{ tenant: "globex", delivered: true, attempts: 1 },
		]);
		expect(changeUser(deps, "alice", "disable")).toBe(false);

		removeMember(deps, "acme", "bob");
		expect(await deliverRevocations(deps, "bob")).toEqual([{ tenant: "acme", delivered: true, attempts: 1 }]);

		changeUser(deps, "alice", "enable");
		changeUser(deps, "alice", "revoke-sessions");
		expect((await deliverRevocations(deps, "alice")).map(({ delivered }) => delivered)).toEqual([true, true]);

		expect(() => changeUser(deps, "alice", "delete")).toThrow(/removes every membership/);
		changeUser(deps, "alice", "delete", "alice");
		expect(rows(db, "select count(*) as n from memberships where subject = 'alice'")).toEqual([{ n: 0 }]);
		expect(listUsers(deps).find(({ subject }) => subject === "alice")?.status).toBe("deleted");
		expect(() => changeUser(deps, "alice", "enable")).toThrow(/deleted/);
	});

	it("stores only an invitation's hash, and expired or revoked invitations are not pending", () => {
		const db = globalDatabase();
		tenant(db, "acme");
		const { deps, advance } = operator(db);
		createRole(deps, "acme", "agent");
		const invite = createInvite(deps, "acme", "agent", "72h");
		expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const stored = JSON.stringify(rows(db, "select * from invitations"));
		expect(stored).not.toContain(invite.token);
		expect(stored).toContain(tokenHash(invite.token));
		expect(() => createInvite(deps, "acme", "boss")).toThrow(/not declared/);
		expect(() => createInvite(deps, "acme", "agent", "90d")).toThrow(/between 1h and 30d/);

		const second = createInvite(deps, "acme", "agent", "1h");
		revokeInvite(deps, "acme", second.id);
		expect(() => revokeInvite(deps, "acme", second.id)).toThrow(/already revoked/);
		advance(73);
		expect(listInvites(deps, "acme").map(({ state }) => state)).toEqual(["expired", "revoked"]);
	});
});
