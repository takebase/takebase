import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addMember, addTenant, emulatorToken, listTenants } from "./fixtures.ts";

// The real MembershipEntrypoint RPC that tenant Workers reach over their service binding.
const verifyMembership = (token: string, tenantId: string) =>
	exports.MembershipEntrypoint.verifyMembership(token, tenantId);

describe("membership boundary (S-3-1-01)", () => {
	it("a disabled tenant and a removed member lose access on the next request", async () => {
		await addTenant("acme");
		await addMember("acme", "user-acme", "editor");
		await addMember("acme", "user-acme", "manager");
		const token = emulatorToken("user-acme");

		expect(await verifyMembership(token, "acme")).toEqual({
			status: "member",
			identity: { id: "user-acme", provider: "firebase", roles: ["editor", "manager"] },
			revision: 2,
		});
		expect(await verifyMembership("not-a-token", "acme")).toEqual({ status: "invalid_token" });

		await env.DB.prepare("update tenants set status = 'disabled' where id = 'acme'").run();
		expect(await verifyMembership(token, "acme")).toEqual({ status: "not_member", subject: "user-acme", revision: 3 });
		expect(await (await listTenants(token)).json()).toEqual({ tenants: [] });

		await env.DB.prepare("update tenants set status = 'active' where id = 'acme'").run();
		await env.DB.prepare("delete from memberships where subject = 'user-acme'").run();
		expect(await verifyMembership(token, "acme")).toEqual({ status: "not_member", subject: "user-acme", revision: 6 });
	});

	it("a disabled identity, or a sign-in before its sessions were revoked, is refused everywhere (R-5-2-01)", async () => {
		await addTenant("umbrella");
		await addMember("umbrella", "user-u", "editor");
		const now = Math.floor(Date.now() / 1000);
		const before = emulatorToken("user-u", now - 120);
		const identity = (sql: string) => env.DB.prepare(sql).run();
		expect(await verifyMembership(before, "umbrella")).toMatchObject({ status: "member" });

		await identity(
			"insert into identities (provider, subject, status, created, updated) values ('firebase', 'user-u', 'disabled', 'now', 'now')",
		);
		expect(await verifyMembership(before, "umbrella")).toEqual({ status: "invalid_token" });
		expect((await listTenants(before)).status).toBe(401);

		await identity(
			`update identities set status = 'active', sessions_valid_after = ${now - 60} where subject = 'user-u'`,
		);
		// Signed in before the revocation: refused. A fresh sign-in after it: accepted.
		expect(await verifyMembership(before, "umbrella")).toEqual({ status: "invalid_token" });
		expect((await listTenants(before)).status).toBe(401);
		const after = emulatorToken("user-u", now);
		expect(await verifyMembership(after, "umbrella")).toMatchObject({ status: "member" });
		expect((await listTenants(after)).status).toBe(200);

		await identity("update identities set status = 'deleted' where subject = 'user-u'");
		expect(await verifyMembership(after, "umbrella")).toEqual({ status: "invalid_token" });
	});

	it("global D1 rejects duplicate memberships, unknown tenants and unknown statuses", async () => {
		await addTenant("globex");
		await addMember("globex", "user-globex", "manager");
		await expect(addMember("globex", "user-globex", "manager")).rejects.toThrow(/constraint/i);
		await expect(addMember("no-such-tenant", "user-globex", "manager")).rejects.toThrow(/constraint/i);
		await expect(addTenant("initech", "paused")).rejects.toThrow(/constraint/i);
	});
});
