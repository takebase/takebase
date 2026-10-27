import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addMember, addTenant, emulatorToken } from "./fixtures.ts";

// The global Worker's tenant administration and invitation routes (R-5-2-01):
// who may call them, what the D1 rules refuse, and single-use invitations.

const call = (path: string, user: string | null, method = "GET", body?: unknown) =>
	exports.default.fetch(`https://global.local${path}`, {
		method,
		headers: {
			...(user === null ? {} : { authorization: `Bearer ${emulatorToken(user)}` }),
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
const json = async (response: Response) => ({ status: response.status, body: (await response.json()) as never });
const run = (sql: string) => env.DB.prepare(sql).run();
const all = async (sql: string) => (await env.DB.prepare(sql).all()).results;
const admin = (tenant: string) => `/api/admin/tenants/${tenant}`;

describe("tenant administration routes", () => {
	it("are open only to an admin of that active tenant", async () => {
		await addTenant("acme");
		await addTenant("globex");
		await addMember("acme", "ada", "admin");
		await addMember("acme", "bob", "agent");
		await addMember("globex", "carol", "admin");

		expect((await call(`${admin("acme")}/members`, null)).status).toBe(401);
		expect((await call(`${admin("acme")}/members`, "bob")).status).toBe(403);
		// Bob cannot promote himself: the guard refuses before any change.
		expect((await call(`${admin("acme")}/members`, "bob", "POST", { uid: "bob", role: "admin" })).status).toBe(403);
		// Another tenant's admin, and an unknown tenant, look the same.
		expect((await call(`${admin("acme")}/members`, "carol")).status).toBe(403);
		expect((await call(`${admin("initech")}/members`, "ada")).status).toBe(403);
		expect(await json(await call(`${admin("acme")}/members`, "ada"))).toEqual({
			status: 200,
			body: {
				members: [
					{ uid: "ada", roles: ["admin"] },
					{ uid: "bob", roles: ["agent"] },
				],
			},
		});

		await run("update tenants set status = 'disabled' where id = 'acme'");
		expect((await call(`${admin("acme")}/members`, "ada")).status).toBe(403);
		await run("update tenants set status = 'active' where id = 'acme'");
		await run(
			"insert into identities (provider, subject, status, created, updated) values ('firebase', 'ada', 'disabled', 'now', 'now')",
		);
		expect((await call(`${admin("acme")}/members`, "ada")).status).toBe(401);
		expect(await all("select count(*) as n from audit_events")).toEqual([{ n: 0 }]);
	});

	it("let an admin manage members and roles within the rules, auditing every change", async () => {
		await addTenant("hooli");
		await addMember("hooli", "alice", "admin");
		const members = `${admin("hooli")}/members`;

		expect((await call(`${admin("hooli")}/roles`, "alice", "POST", { name: "support" })).status).toBe(201);
		expect((await call(members, "alice", "POST", { uid: "dave", role: "support" })).status).toBe(201);
		expect(await json(await call(members, "alice", "POST", { uid: "dave", role: "owner" }))).toEqual({
			status: 422,
			body: {
				error: {
					code: "validation_failed",
					message: "The given data was invalid.",
					fields: { role: "The selected role is invalid." },
				},
			},
		});
		expect((await call(`${admin("hooli")}/roles`, "alice", "POST", { name: "Bad Name" })).status).toBe(422);
		expect((await call(members, "alice", "POST", { uid: "dave", role: "support" })).status).toBe(409);
		expect((await call(`${members}/alice?role=admin`, "alice", "DELETE")).status).toBe(409);
		expect((await call(`${admin("hooli")}/roles/admin`, "alice", "DELETE")).status).toBe(409);
		expect((await call(`${admin("hooli")}/roles/support`, "alice", "DELETE")).status).toBe(409);

		expect(await json(await call(`${members}/dave`, "alice", "DELETE"))).toEqual({
			status: 200,
			body: { reconcile: "https://hooli.example.test/api/realtime/reconcile" },
		});
		expect(await all("select subject from member_revocations where tenant_id = 'hooli' and confirmed is null")).toEqual(
			[{ subject: "dave" }],
		);
		// Admins are peers: one may make another (D4).
		expect((await call(members, "alice", "POST", { uid: "erin", role: "admin" })).status).toBe(201);
		expect((await call(`${members}/alice`, "alice", "DELETE")).status).toBe(200);
		expect(
			await all("select actor, action, target from audit_events where tenant_id = 'hooli' order by created, action"),
		).toEqual([
			{ actor: "firebase:alice", action: "role.create", target: "support" },
			{ actor: "firebase:alice", action: "member.add", target: "dave" },
			{ actor: "firebase:alice", action: "member.remove", target: "dave" },
			{ actor: "firebase:alice", action: "member.add", target: "erin" },
			{ actor: "firebase:alice", action: "member.remove", target: "alice" },
		]);
	});
});

describe("invitations", () => {
	const create = async (tenant: string, role: string, expiresInHours?: number) => {
		const response = await call(`${admin(tenant)}/invites`, "alice", "POST", { role, expiresInHours });
		expect(response.status).toBe(201);
		return (await response.json()) as { id: string; token: string };
	};
	const redeem = (user: string | null, token: string) => call("/api/invites/redeem", user, "POST", { token });

	it("are redeemed once, before they expire, while the tenant is active", async () => {
		await addTenant("umbrella");
		await addMember("umbrella", "alice", "admin");
		await addMember("umbrella", "alice", "agent");

		const invite = await create("umbrella", "agent");
		expect(JSON.stringify(await all("select * from invitations"))).not.toContain(invite.token);
		expect((await redeem(null, invite.token)).status).toBe(401);
		expect(await json(await redeem("erin", invite.token))).toEqual({
			status: 200,
			body: {
				tenant: { id: "umbrella", name: "Tenant umbrella", url: "https://umbrella.example.test" },
				role: "agent",
			},
		});
		expect(await all("select role from memberships where subject = 'erin' and tenant_id = 'umbrella'")).toEqual([
			{ role: "agent" },
		]);
		// Replayed, by the same user or another: nothing more.
		expect((await redeem("erin", invite.token)).status).toBe(404);
		expect((await redeem("frank", invite.token)).status).toBe(404);
		expect(await all("select count(*) as n from memberships where subject = 'frank'")).toEqual([{ n: 0 }]);

		// Two redemptions at once: exactly one wins.
		const raced = await create("umbrella", "agent");
		const statuses = (await Promise.all([redeem("gus", raced.token), redeem("hal", raced.token)])).map((r) => r.status);
		expect(statuses.sort()).toEqual([200, 404]);

		const expired = await create("umbrella", "agent", 1);
		await run(`update invitations set expires = '2000-01-01T00:00:00.000Z' where id = '${expired.id}'`);
		expect((await redeem("ivy", expired.token)).status).toBe(404);

		const revoked = await create("umbrella", "agent");
		expect((await call(`${admin("umbrella")}/invites/${revoked.id}`, "alice", "DELETE")).status).toBe(200);
		expect((await redeem("ivy", revoked.token)).status).toBe(404);

		const roleGone = await create("umbrella", "agent");
		await run("delete from memberships where role = 'agent' and tenant_id = 'umbrella'");
		await run("delete from tenant_roles where tenant_id = 'umbrella' and name = 'agent'");
		expect((await redeem("ivy", roleGone.token)).status).toBe(404);

		const disabled = await create("umbrella", "admin");
		await run("update tenants set status = 'disabled' where id = 'umbrella'");
		expect((await redeem("ivy", disabled.token)).status).toBe(404);
		expect(await all("select count(*) as n from memberships where subject = 'ivy'")).toEqual([{ n: 0 }]);
		expect((await redeem("ivy", "not-a-real-invitation-token-at-all")).status).toBe(404);
		expect(
			await all("select count(*) as n from audit_events where action = 'invite.redeem' and tenant_id = 'umbrella'"),
		).toEqual([{ n: 2 }]);
	});
});
