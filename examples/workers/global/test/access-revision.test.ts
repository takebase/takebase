import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addMember, addTenant, emulatorToken } from "./fixtures.ts";

const revision = async (tenantId: string) =>
	(await env.DB.prepare("select access_revision from tenants where id = ?")
		.bind(tenantId)
		.first<number>("access_revision")) ?? null;
const run = (query: string) => env.DB.prepare(query).run();

describe("tenants.access_revision (S-4-2-01)", () => {
	it("moves forward on every access change and only on access changes", async () => {
		await addTenant("hooli");
		await addTenant("pied-piper");
		expect(await revision("hooli")).toBe(0);

		await addMember("hooli", "user-1", "editor");
		expect(await revision("hooli")).toBe(1);
		await run("update memberships set role = 'admin' where subject = 'user-1' and tenant_id = 'hooli'");
		expect(await revision("hooli")).toBe(2);
		await run("update tenants set status = 'disabled' where id = 'hooli'");
		expect(await revision("hooli")).toBe(3);
		await run("update tenants set status = 'active' where id = 'hooli'");
		expect(await revision("hooli")).toBe(4);
		await run("delete from memberships where subject = 'user-1'");
		expect(await revision("hooli")).toBe(5);

		// Renames, timestamp touches and same-status writes grant or revoke nothing.
		await addMember("hooli", "user-2", "editor");
		await run("update tenants set name = 'Hooli XYZ', status = 'active' where id = 'hooli'");
		await run("update memberships set updated = 'later' where subject = 'user-2'");
		expect(await revision("hooli")).toBe(6);
		// Other tenants are untouched.
		expect(await revision("pied-piper")).toBe(0);
	});

	it("never decreases", async () => {
		await addTenant("initrode");
		await addMember("initrode", "user-1", "editor");
		await expect(run("update tenants set access_revision = 0 where id = 'initrode'")).rejects.toThrow(
			/never decreases/,
		);
		expect(await revision("initrode")).toBe(1);
	});

	it("a revocation always carries a higher revision than any grant read before it", async () => {
		await addTenant("vandelay");
		await addMember("vandelay", "user-1", "editor");
		const token = emulatorToken("user-1");
		const verify = () => exports.MembershipEntrypoint.verifyMembership(token, "vandelay");

		const granted = await verify();
		expect(granted).toMatchObject({ status: "member", revision: 1 });
		await run("delete from memberships where subject = 'user-1' and tenant_id = 'vandelay'");
		const revoked = await verify();
		expect(revoked).toEqual({ status: "not_member", subject: "user-1", revision: 2 });
		// An unknown tenant has no revision to revoke at.
		expect(await exports.MembershipEntrypoint.verifyMembership(token, "no-such-tenant")).toEqual({
			status: "not_member",
			subject: "user-1",
			revision: null,
		});
	});
});
