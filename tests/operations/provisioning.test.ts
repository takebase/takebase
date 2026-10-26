import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	provisionTenant,
	type TenantPlan,
	type TenantProvider,
	type WorkerBindings,
} from "../../packages/cli/src/services/provisioning.ts";
import { deleteTenant, disableTenant, type LifecycleDeps } from "../../packages/cli/src/services/tenant-lifecycle.ts";

// MOCKED PROVIDER: an in-memory stand-in for Firebase, Cloudflare and global D1.
// It proves the engine's ordering and resume logic only; the local provider is
// exercised against the emulators and local D1, and real providers in staging.
// Creating a resource that already exists throws, so a duplicate fails the test.

const plan: TenantPlan = {
	rules: (uid) => ({ rules: { dispatcher: uid } }),
	bindings: (id): WorkerBindings => ({
		vars: { TENANT_ID: "acme" },
		services: [{ binding: "GLOBAL", service: "global", entrypoint: "MembershipEntrypoint" }],
		d1_databases: [{ binding: "DB", database_name: "acme", database_id: id, migrations_dir: "m" }],
	}),
	url: "https://acme.example.test",
};

const world = (crashAfter = 0) => {
	const state = {
		realtime: false,
		dispatcher: null as string | null,
		rules: null as unknown,
		database: null as string | null,
		bindings: null as WorkerBindings | null,
		pending: 2,
		stale: true,
		deployed: false,
		registration: null as { status: string; url: string } | null,
	};
	const created: Record<string, number> = {};
	let actions = 0;
	// Every change goes through here: it runs, is counted, and then the
	// "process" may crash, leaving the change in place.
	const act = async <T>(name: string, change: () => T): Promise<T> => {
		const result = change();
		created[name] = (created[name] ?? 0) + 1;
		actions++;
		if (actions === crashAfter) throw new Error(`crash after action ${actions} (${name})`);
		return result;
	};
	const once = (exists: boolean, name: string) => {
		if (exists) throw new Error(`duplicate ${name}`);
	};
	const provider: TenantProvider = {
		realtimeDatabase: async () => state.realtime,
		createRealtimeDatabase: () =>
			act("realtime", () => {
				once(state.realtime, "realtime database");
				state.realtime = true;
			}),
		dispatcher: async () => state.dispatcher,
		createDispatcher: () =>
			act("dispatcher", () => {
				once(state.dispatcher !== null, "dispatcher");
				state.dispatcher = "uid-1";
				return state.dispatcher;
			}),
		rules: async () => state.rules,
		writeRules: (rules) =>
			act("rules", () => {
				state.rules = rules;
			}),
		database: async () => state.database,
		createDatabase: () =>
			act("database", () => {
				once(state.database !== null, "D1 database");
				state.database = "db-1";
				return state.database;
			}),
		bindings: async () => state.bindings,
		writeBindings: (bindings) =>
			act("bindings", () => {
				once(state.bindings !== null, "Wrangler environment");
				state.bindings = bindings;
			}),
		pendingMigrations: async () => state.pending,
		applyMigrations: () =>
			act("migrations", () => {
				state.pending = 0;
			}),
		staleSignals: async () => state.stale,
		clearSignals: () =>
			act("signals", () => {
				state.stale = false;
			}),
		deployed: async () => state.deployed,
		deploy: () =>
			act("deploy", () => {
				state.deployed = true;
			}),
		registration: async () => state.registration,
		register: (url) =>
			act("registration", () => {
				once(state.registration !== null, "registration");
				state.registration = { status: "active", url };
			}),
	};
	return { state, created, provider, actions: () => actions };
};

const ready = { realtime: 1, dispatcher: 1, rules: 1, database: 1, bindings: 1, migrations: 1, signals: 1, deploy: 1 };

describe("tenant provisioning with a mocked provider (S-5-1-01)", () => {
	const total = 9;

	it.each(Array.from({ length: total }, (_, index) => index + 1))(
		"a crash after provider action %i, then a rerun, gives one ready tenant without duplicates",
		async (crashAfter) => {
			const { state, created, provider } = world(crashAfter);
			await expect(provisionTenant(provider, plan)).rejects.toThrow(`crash after action ${crashAfter}`);
			// Never presented as ready before the last step.
			if (crashAfter < total) expect(state.registration).toBeNull();

			const rerun = await provisionTenant(provider, plan);
			expect(rerun.every(({ outcome }) => outcome === "exists" || outcome === "created")).toBe(true);
			expect(state.registration).toEqual({ status: "active", url: plan.url });
			expect(created).toEqual({ ...ready, registration: 1 });
		},
	);

	it("a provisioned tenant is left alone, and --plan never changes anything", async () => {
		const fresh = world();
		const planned = await provisionTenant(fresh.provider, plan, { plan: true });
		expect(fresh.actions()).toBe(0);
		expect(planned.find(({ step }) => step === "registration")?.outcome).toBe("missing");

		await provisionTenant(fresh.provider, plan);
		expect(fresh.actions()).toBe(total);
		const again = await provisionTenant(fresh.provider, plan);
		expect(fresh.actions()).toBe(total);
		expect(again.map(({ outcome }) => outcome)).toEqual(Array(total).fill("exists"));
	});

	it("stops on drifted bindings without overwriting them or registering", async () => {
		const { state, provider } = world();
		state.realtime = true;
		state.database = "db-1";
		const drifted = { ...plan.bindings("db-1"), vars: { TENANT_ID: "someone-else" } };
		state.bindings = drifted;
		await expect(provisionTenant(provider, plan)).rejects.toThrow(/differs/);
		expect(state.bindings).toBe(drifted);
		expect(state.registration).toBeNull();
		const planned = await provisionTenant(provider, plan, { plan: true });
		expect(planned.find(({ step }) => step === "worker bindings")?.outcome).toBe("unknown");
	});
});

// Global D1 stand-in: SQLite with the real migrations/global applied, so the
// access-revision and revocation triggers are the deployed ones. The tenant
// Worker is scripted: `reachable` decides whether reconcile delivers.
const globalDatabase = () => {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	const dir = new URL("../../migrations/global/", import.meta.url);
	for (const file of readdirSync(dir)
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		for (const statement of readFileSync(new URL(file, dir), "utf8").split("--> statement-breakpoint"))
			db.exec(statement);
	}
	const now = "2026-10-26T00:00:00.000Z";
	db.exec(
		`insert into tenants (id, name, url, status, created, updated) values ('acme', 'Acme', 'https://acme.example.test', 'active', '${now}', '${now}')`,
	);
	db.exec(
		`insert into memberships (id, tenant_id, provider, subject, role, created, updated) values ('m1', 'acme', 'firebase', 'alice', 'agent', '${now}', '${now}')`,
	);
	return db;
};

const lifecycle = (db: DatabaseSync, reachable: () => boolean) => {
	const calls: string[] = [];
	const deps: LifecycleDeps = {
		query: (sql) => db.prepare(sql).all() as Record<string, unknown>[],
		reconcile: async (url) => {
			calls.push(url);
			if (!reachable()) return 0;
			// What the tenant Worker does: revoke everything, then confirm (see core reconcileRevocation).
			db.exec("update tenant_revocations set confirmed = 'now' where tenant_id = 'acme' and confirmed is null");
			return 200;
		},
		wait: async () => {},
		now: () => new Date("2026-10-26T01:00:00.000Z"),
	};
	return { deps, calls };
};

// What the membership check reads (packages/core memberships service).
const memberRoles = (db: DatabaseSync) =>
	db
		.prepare(
			"select m.role from memberships m join tenants t on t.id = m.tenant_id where t.id = 'acme' and t.status = 'active' and m.subject = 'alice'",
		)
		.all();

describe("tenant disable and delete against the real global schema (R-5-1-01)", () => {
	it("disable denies access in the same statement and delivers the revocation, retrying until confirmed", async () => {
		const db = globalDatabase();
		expect(memberRoles(db)).toHaveLength(1);
		let up = false;
		const { deps, calls } = lifecycle(db, () => up);

		const first = await disableTenant(deps, "acme", { attempts: 3 });
		// Denied before any realtime delivery succeeded.
		expect(memberRoles(db)).toEqual([]);
		expect(first).toMatchObject({ changed: true, rev: 2, delivered: false, attempts: 3 });
		expect(calls).toEqual(Array(3).fill("https://acme.example.test"));

		up = true;
		expect(await disableTenant(deps, "acme")).toMatchObject({ changed: false, rev: 2, delivered: true, attempts: 1 });
		expect(await disableTenant(deps, "acme")).toMatchObject({ changed: false, rev: null, delivered: true });
	});

	it("delete never removes an active tenant, one with a pending revocation, or one without --confirm", async () => {
		const db = globalDatabase();
		let up = false;
		const { deps } = lifecycle(db, () => up);
		expect(() => deleteTenant(deps, "acme", "acme")).toThrow(/is active; disable it first/);

		await disableTenant(deps, "acme", { attempts: 1 });
		expect(() => deleteTenant(deps, "acme", "acme")).toThrow(/revocation 2 pending/);

		up = true;
		await disableTenant(deps, "acme");
		expect(() => deleteTenant(deps, "acme", undefined)).toThrow(/removes its registration and memberships/);
		expect(() => deleteTenant(deps, "acme", "other")).toThrow(/removes its registration and memberships/);
		expect(db.prepare("select count(*) as n from tenants").get()).toEqual({ n: 1 });

		deleteTenant(deps, "acme", "acme");
		expect(db.prepare("select count(*) as n from tenants").get()).toEqual({ n: 0 });
		expect(db.prepare("select count(*) as n from memberships").get()).toEqual({ n: 0 });
		expect(() => deleteTenant(deps, "acme", "acme")).toThrow(/not registered/);
	});
});
