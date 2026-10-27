import { describe, expect, it } from "vitest";
import { createClient, type Fetch, TakebaseError } from "../src/index.ts";
import { fakeAuth, globalUrl, membership, withDiscovery } from "./helpers.ts";

const page = { items: [], page: 1, perPage: 20, totalItems: 0, totalPages: 0 };

type Sent = { url: string; authorization: string | undefined };

// Records where each request went and which bearer token it carried.
const tracking = (respond: (url: string) => Response = () => Response.json(page)) => {
	const sent: Sent[] = [];
	const fetch: Fetch = async (url, init) => {
		sent.push({ url, authorization: (init.headers as Record<string, string>).authorization });
		return respond(url);
	};
	return { sent, fetch };
};

const failure = async (promise: Promise<unknown>) => {
	const error = await promise.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(TakebaseError);
	return error as TakebaseError;
};

describe("SDK authentication and tenant routing", () => {
	it("refreshes the ID token once after a 401 and retries the request", async () => {
		let statuses = [401, 200];
		const { sent, fetch } = tracking(() => {
			const status = statuses.shift() ?? 401;
			return status === 200
				? Response.json(page)
				: Response.json({ error: { code: "unauthenticated", message: "x" } }, { status });
		});
		const tenants = [membership("t1", "https://t1.example")];
		const client = createClient({ globalUrl, auth: fakeAuth().auth, fetch: withDiscovery(tenants, fetch) });
		await client.useTenant("t1");

		await client.collection("policies").getList();
		expect(sent.map(({ authorization }) => authorization)).toEqual(["Bearer user-1-token-0", "Bearer user-1-token-1"]);

		statuses = [401, 401];
		expect(await failure(client.collection("policies").getList())).toMatchObject({
			status: 401,
			code: "unauthenticated",
		});
		expect(sent).toHaveLength(4);
	});

	it("redeems an invitation at the global Worker only, as the signed-in user", async () => {
		const redemption = { tenant: { id: "t1", name: "T1", url: "https://t1.example" }, role: "agent" };
		const { sent, fetch } = tracking(() => Response.json(redemption));
		const client = createClient({ globalUrl, auth: fakeAuth().auth, fetch });
		expect(await client.invites.redeem("invite-token")).toEqual(redemption);
		expect(sent).toEqual([{ url: `${globalUrl}/api/invites/redeem`, authorization: "Bearer user-1-token-0" }]);

		const refused = tracking(() =>
			Response.json(
				{ error: { code: "not_found", message: "The invitation is invalid, used or expired" } },
				{ status: 404 },
			),
		);
		const other = createClient({ globalUrl, auth: fakeAuth().auth, fetch: refused.fetch });
		expect((await failure(other.invites.redeem("used-token"))).code).toBe("not_found");
	});

	it("routes only to tenants the global Worker lists, over https, and sends tokens nowhere else", async () => {
		const { sent, fetch } = tracking();
		const tenants = [membership("t1", "https://t1.example/"), membership("bad", "http://attacker.example")];
		const client = createClient({ globalUrl, auth: fakeAuth().auth, fetch: withDiscovery(tenants, fetch) });

		expect(await failure(client.useTenant("not-listed"))).toMatchObject({ code: "forbidden" });
		expect(await failure(client.useTenant("bad"))).toMatchObject({ code: "invalid_response" });
		expect(client.tenant()).toBeNull();
		expect(() => client.collection("policies")).toThrow(/useTenant/);

		await client.useTenant("t1");
		await client.collection("policies").getList();
		expect(sent.map(({ url }) => url)).toEqual(["https://t1.example/api/collections/policies/records"]);

		for (const unsafe of ["http://global.example", "https://user:pass@global.example", "https://global.example?x=1"])
			expect(() => createClient({ globalUrl: unsafe, auth: fakeAuth().auth, fetch }), unsafe).toThrow(TypeError);
		expect(() => createClient({ globalUrl: "http://localhost:8787", auth: fakeAuth().auth, fetch })).not.toThrow();
	});

	it("rejects stale collection handles after a tenant switch, a user change or sign-out", async () => {
		const { sent, fetch } = tracking();
		const tenants = [membership("t1", "https://t1.example"), membership("t2", "https://t2.example")];
		const { auth, signIn } = fakeAuth();
		const client = createClient({ globalUrl, auth, fetch: withDiscovery(tenants, fetch) });

		await client.useTenant("t1");
		const first = client.collection("policies");
		await client.useTenant("t2");
		expect(await failure(first.getList())).toMatchObject({ code: "tenant_changed" });
		await client.collection("policies").getList();

		const second = client.collection("policies");
		signIn("user-2");
		expect(client.tenant()).toBeNull();
		expect(await failure(second.getList())).toMatchObject({ code: "tenant_changed" });

		await client.useTenant("t1");
		await client.auth.signOut();
		expect(client.tenant()).toBeNull();
		expect(sent.map(({ url }) => new URL(url).origin)).toEqual(["https://t2.example"]);
	});
});
