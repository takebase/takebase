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

// A realtime adapter whose revokeAll can be made to fail; everything else is unused.
const adapter = (fail: boolean) => {
	const revoked: number[] = [];
	const unused = async () => {};
	const realtime: RealtimeAdapter = {
		publish: unused,
		grant: unused,
		revoke: unused,
		revokeAll: async (rev) => {
			if (fail) throw new Error("realtime unavailable");
			revoked.push(rev);
		},
		connection: {},
	};
	return { realtime, revoked };
};

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
		expect(await reconcileRevocation(source, working.realtime, "umbrella")).toEqual({ revoked: 1 });
		expect(working.revoked).toEqual([1]);
		expect(await revocations("umbrella")).toEqual([{ rev: 1, confirmed: 1 }]);
		expect(await reconcileRevocation(source, working.realtime, "umbrella")).toEqual({ revoked: null });
		// One tenant's revocation never answers for another.
		expect(await source.pendingRevocation("globex")).toBeNull();
	});
});
