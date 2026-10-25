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
		await addMember("acme", "user-acme", "admin");
		const token = emulatorToken("user-acme");

		expect(await verifyMembership(token, "acme")).toEqual({
			status: "member",
			identity: { id: "user-acme", provider: "firebase", roles: ["admin", "editor"] },
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

	it("global D1 rejects duplicate memberships, unknown tenants and unknown statuses", async () => {
		await addTenant("globex");
		await addMember("globex", "user-globex", "admin");
		await expect(addMember("globex", "user-globex", "admin")).rejects.toThrow(/constraint/i);
		await expect(addMember("no-such-tenant", "user-globex", "admin")).rejects.toThrow(/constraint/i);
		await expect(addTenant("initech", "paused")).rejects.toThrow(/constraint/i);
	});
});
