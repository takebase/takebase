import { describe, expect, it } from "vitest";
import { createClient, type Fetch, TakebaseError } from "../src/index.ts";
import { fakeAuth, globalUrl, membership, withDiscovery } from "./helpers.ts";

const tenantUrl = "https://t1.example";

type Sent = { method: string; url: string; authorization: string | undefined };

// Records every request; `respond` answers by method and URL.
const tracking = (respond: (method: string, url: string) => Response) => {
	const sent: Sent[] = [];
	const fetch: Fetch = async (url, init) => {
		const method = init.method ?? "GET";
		sent.push({ method, url, authorization: (init.headers as Record<string, string>).authorization });
		return respond(method, url);
	};
	return { sent, fetch };
};

const adminOf = async (fetch: Fetch, auth = fakeAuth()) => {
	const tenants = [membership("t/1", tenantUrl, ["admin"]), membership("t2", "https://t2.example")];
	const client = createClient({ globalUrl, auth: auth.auth, fetch: withDiscovery(tenants, fetch) });
	await client.useTenant("t/1");
	return { client, admin: client.admin() };
};

const failure = async (promise: Promise<unknown>) => {
	const error = await promise.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(TakebaseError);
	return error as TakebaseError;
};

describe("SDK administration and diagnostics", () => {
	it("sends admin calls only to fixed paths of the global Worker and the selected tenant", async () => {
		const { sent, fetch } = tracking((method, url) => {
			if (url.includes("/members/") && method === "DELETE") {
				// A reconcile URL chosen by the answer is never followed.
				return Response.json({ reconcile: "https://elsewhere.example/api/realtime/reconcile" });
			}
			if (url.endsWith("/reconcile")) return Response.json({ revoked: 1 });
			if (url.endsWith("/members")) return Response.json({ members: [{ uid: "u1", roles: ["admin"] }] });
			return Response.json({ revived: 2 });
		});
		const { admin } = await adminOf(fetch);

		expect(await admin.members.list()).toEqual([{ uid: "u1", roles: ["admin"] }]);
		expect(await admin.members.remove("u/2", "agent")).toEqual({ reconciled: true });
		expect(await admin.retryOutbox({ dead: true })).toEqual({ revived: 2 });

		expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
			`GET ${globalUrl}/api/admin/tenants/t%2F1/members`,
			`DELETE ${globalUrl}/api/admin/tenants/t%2F1/members/u%2F2?role=agent`,
			`POST ${tenantUrl}/api/realtime/reconcile`,
			`POST ${tenantUrl}/api/admin/outbox/retry`,
		]);
		expect(sent.every(({ url }) => url.startsWith(globalUrl) || url.startsWith(tenantUrl))).toBe(true);
	});

	it("rejects a handle's calls after a tenant switch or sign-out, sending nothing", async () => {
		const auth = fakeAuth();
		const { sent, fetch } = tracking(() => Response.json({ roles: [] }));
		const { client, admin } = await adminOf(fetch, auth);

		await client.useTenant("t2");
		expect(await failure(admin.roles.list())).toMatchObject({ code: "tenant_changed" });
		const second = client.admin();
		auth.signIn(null);
		expect(await failure(second.diagnostics())).toMatchObject({ code: "tenant_changed" });
		expect(await failure(second.members.remove("u1"))).toMatchObject({ code: "tenant_changed" });
		expect(sent).toEqual([]);
	});

	it("surfaces Worker refusals and rejects unusable answers", async () => {
		const { fetch } = tracking((_method, url) => {
			if (url.endsWith("/api/admin/diagnostics")) {
				return Response.json({ error: { code: "forbidden", message: "Admins only" } }, { status: 403 });
			}
			if (url.endsWith("/health/ready") && url.startsWith(tenantUrl)) {
				return Response.json({ service: "tenant", status: "error", checks: { db: "error" } }, { status: 503 });
			}
			if (url.endsWith("/health/ready")) return Response.json({ status: "fine" });
			return Response.json({ invites: [{ id: "i1", role: "agent", state: "pending" }] });
		});
		const { admin } = await adminOf(fetch);

		expect(await failure(admin.diagnostics())).toMatchObject({ status: 403, code: "forbidden" });
		expect(await admin.readiness("tenant")).toEqual({ service: "tenant", status: "error", checks: { db: "error" } });
		expect(await failure(admin.readiness("global"))).toMatchObject({ code: "invalid_response" });
		expect(await failure(admin.invites.list())).toMatchObject({ code: "invalid_response" });
	});
});
