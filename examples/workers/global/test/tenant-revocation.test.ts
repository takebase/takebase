import { env, exports } from "cloudflare:workers";
import { type RealtimeAdapter, reconcileRevocation } from "@takebase/core";
import { describe, expect, it } from "vitest";
import { addMember, addTenant } from "./fixtures.ts";

const run = (query: string) => env.DB.prepare(query).run();
const revocations = (tenantId: string) =>
	env.DB.prepare(
		"select rev, confirmed is not null as confirmed from tenant_revocations where tenant_id = ? order by rev",
	)
		.bind(tenantId)
		.all<{ rev: number; confirmed: number }>()
		.then(({ results }) => results);
const source = exports.MembershipEntrypoint;

// A realtime adapter whose revocations can be made to fail; publish and grant are unused.
const adapter = (fail: boolean) => {
	const revoked: number[] = [];
	const members: [string, number][] = [];
	const unused = async () => {};
	const realtime: RealtimeAdapter = {
		publish: unused,
		grant: unused,
		revoke: async (uid, rev) => {
			if (fail) throw new Error("realtime unavailable");
			members.push([uid, rev]);
		},
		revokeAll: async (rev) => {
			if (fail) throw new Error("realtime unavailable");
			revoked.push(rev);
		},
		connection: {},
	};
	return { realtime, revoked, members };
};
const memberRevocations = (tenantId: string) =>
	env.DB.prepare(
		"select subject, rev, confirmed is not null as confirmed from member_revocations where tenant_id = ? order by subject, rev",
	)
		.bind(tenantId)
		.all<{ subject: string; rev: number; confirmed: number }>()
		.then(({ results }) => results);

describe("tenant-wide realtime revocation (R-5-1-01)", () => {
	it("commits with the disable itself, and only while the tenant is disabled", async () => {
		await addTenant("globex");
		await addMember("globex", "user-1", "agent");
		expect(await revocations("globex")).toEqual([]);

		// The access-revision trigger and this one run inside the UPDATE statement.
		await run("update tenants set status = 'disabled' where id = 'globex'");
		expect(await revocations("globex")).toEqual([{ rev: 2, confirmed: 0 }]);
		expect(await source.pendingRevocation("globex")).toBe(2);

		// A tenant enabled again owes nothing: revoking at rev 2 would end new grants.
		await run("update tenants set status = 'active' where id = 'globex'");
		expect(await source.pendingRevocation("globex")).toBeNull();
		await addMember("globex", "user-2", "agent");
		expect(await revocations("globex")).toHaveLength(1);
	});

	it("is confirmed only after the realtime service accepted it", async () => {
		await addTenant("umbrella");
		await run("update tenants set status = 'disabled' where id = 'umbrella'");
		const rev = await source.pendingRevocation("umbrella");
		expect(rev).toBe(1);

		const broken = adapter(true);
		await expect(reconcileRevocation(source, broken.realtime, "umbrella")).rejects.toThrow("realtime unavailable");
		expect(await revocations("umbrella")).toEqual([{ rev: 1, confirmed: 0 }]);

		const working = adapter(false);
		expect(await reconcileRevocation(source, working.realtime, "umbrella")).toEqual({ revoked: 1, members: 0 });
		expect(working.revoked).toEqual([1]);
		expect(await revocations("umbrella")).toEqual([{ rev: 1, confirmed: 1 }]);
		expect(await reconcileRevocation(source, working.realtime, "umbrella")).toEqual({ revoked: null, members: 0 });
		// One tenant's revocation never answers for another.
		expect(await source.pendingRevocation("globex")).toBeNull();
	});
});

describe("one user's realtime revocation (R-5-2-01)", () => {
	it("is owed when a user loses their last role or is disabled, and confirmed only after delivery", async () => {
		await addTenant("hooli");
		await addTenant("initech");
		await addMember("hooli", "alice", "agent");
		await addMember("initech", "alice", "agent");
		await addMember("hooli", "bob", "agent");

		await run("delete from memberships where subject = 'bob'");
		await run(
			"insert into identities (provider, subject, status, created, updated) values ('firebase', 'alice', 'disabled', 'now', 'now')",
		);
		const hooli = await source.pendingMemberRevocations("hooli");
		expect(hooli.map(({ subject }) => subject).sort()).toEqual(["alice", "bob"]);
		expect(await source.pendingMemberRevocations("initech")).toEqual([
			{ provider: "firebase", subject: "alice", rev: expect.any(Number) },
		]);

		const broken = adapter(true);
		await expect(reconcileRevocation(source, broken.realtime, "hooli")).rejects.toThrow("realtime unavailable");
		expect((await memberRevocations("hooli")).every(({ confirmed }) => confirmed === 0)).toBe(true);

		const working = adapter(false);
		expect(await reconcileRevocation(source, working.realtime, "hooli")).toEqual({ revoked: null, members: 2 });
		expect(working.members.sort()).toEqual(hooli.map(({ subject, rev }) => [subject, rev]).sort());
		expect((await memberRevocations("hooli")).every(({ confirmed }) => confirmed === 1)).toBe(true);
		expect(await reconcileRevocation(source, working.realtime, "hooli")).toEqual({ revoked: null, members: 0 });
		// One tenant's delivery never confirms another's.
		expect(await source.pendingMemberRevocations("initech")).toHaveLength(1);
	});
});
