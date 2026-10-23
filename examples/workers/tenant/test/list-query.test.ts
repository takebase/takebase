import type { CollectionRecord, ErrorEnvelope, ListEnvelope } from "@takebase/contracts";
import { describe, expect, it } from "vitest";
import { addAgent, authorizedRoutes, countPolicies, json, newPolicy } from "./fixtures.ts";

const base = "https://tenant.local/api/collections/policies/records";
type Policy = CollectionRecord<{ number: string; status: string; premium: number | null; agent_id: string | null }>;

let agents = 0;
// Each test lists only its own records by filtering on a fresh agent.
const seed = async (policies: Record<string, unknown>[], now?: () => Date) => {
	const agentId = await addAgent(`list-${crypto.randomUUID()}-${agents++}`);
	const routes = authorizedRoutes(now);
	const created: Policy[] = [];
	for (const overrides of policies) {
		const response = await routes.request(base, json("POST", newPolicy({ ...overrides, agent_id: agentId })));
		expect(response.status).toBe(201);
		created.push((await response.json()) as Policy);
	}
	const list = async (query: string) => {
		const response = await routes.request(`${base}?filter[agent_id]=${agentId}&${query}`);
		expect(response.status, query).toBe(200);
		return (await response.json()) as ListEnvelope<Policy>;
	};
	return { agentId, created, list, routes };
};

const allPages = async (list: (query: string) => Promise<ListEnvelope<Policy>>, query: string, perPage: number) => {
	const first = await list(`${query}&perPage=${perPage}&page=1`);
	const ids = first.items.map((item) => item.id);
	for (let page = 2; page <= first.totalPages; page++)
		ids.push(...(await list(`${query}&perPage=${perPage}&page=${page}`)).items.map((item) => item.id));
	return { ids, totalItems: first.totalItems, totalPages: first.totalPages };
};

const sortedIds = (records: Policy[], direction: "asc" | "desc" = "asc") => {
	const ids = records.map((record) => record.id).sort();
	return direction === "asc" ? ids : ids.reverse();
};

describe("list filtering, sorting and paging on tenant D1 (authorized fixture)", () => {
	it("counts and pages with the same filtered query", async () => {
		const statuses = ["active", "pending", "active", "cancelled", "active", "active", "pending"];
		const { created, list } = await seed(statuses.map((status) => ({ status })));
		const active = created.filter((record) => record.status === "active");

		const pages = await allPages(list, "filter[status]=active", 2);
		expect(pages.totalItems).toBe(active.length);
		expect(pages.totalPages).toBe(Math.ceil(active.length / 2));
		expect(pages.ids).toHaveLength(active.length);
		expect(new Set(pages.ids)).toEqual(new Set(active.map((record) => record.id)));

		const none = await list("filter[status]=active&filter[status][ne]=active");
		expect(none).toEqual({ items: [], page: 1, perPage: 30, totalItems: 0, totalPages: 0 });
	});

	it("applies each allowed operator with bound values", async () => {
		const premiums = [null, 50, 100, 150, 200];
		const { created, list } = await seed(premiums.map((premium) => ({ premium })));
		const numbers = (page: ListEnvelope<Policy>) => page.items.map((item) => item.premium);

		expect(numbers(await list("filter[premium][gte]=100&sort=premium"))).toEqual([100, 150, 200]);
		expect(numbers(await list("filter[premium][gt]=50&filter[premium][lt]=200&sort=-premium"))).toEqual([150, 100]);
		expect(numbers(await list("filter[premium][lte]=50"))).toEqual([50]);
		expect(numbers(await list("filter[premium][in]=50,200&sort=premium"))).toEqual([50, 200]);
		expect(numbers(await list("filter[premium][null]=true"))).toEqual([null]);
		expect((await list("filter[premium][null]=false")).totalItems).toBe(4);
		expect((await list("filter[premium][ne]=100")).totalItems).toBe(3);
		expect((await list(`filter[number]=${created[2]?.number}`)).items.map((item) => item.id)).toEqual([created[2]?.id]);
	});

	it("orders deterministically when sort values tie, so pages never repeat or skip records", async () => {
		const fixed = new Date("2031-01-01T00:00:00.000Z");
		const { created, list } = await seed(
			Array.from({ length: 7 }, () => ({ premium: 100 })),
			() => fixed,
		);

		// Equal premiums and equal timestamps: the id tiebreak decides.
		const byPremium = await allPages(list, "sort=premium", 3);
		expect(byPremium.ids).toEqual(sortedIds(created));
		expect((await allPages(list, "sort=-premium,-created", 2)).ids).toEqual(sortedIds(created));
		expect((await allPages(list, "", 3)).ids).toEqual(sortedIds(created, "desc"));

		const again = await allPages(list, "sort=premium", 3);
		expect(again.ids).toEqual(byPremium.ids);
	});

	it("sorts by several declared fields in order", async () => {
		const prefix = `M-${crypto.randomUUID().slice(0, 8)}`;
		const { list } = await seed([
			{ premium: 2, number: `${prefix}-b` },
			{ premium: 1, number: `${prefix}-c` },
			{ premium: 2, number: `${prefix}-a` },
		]);
		const page = await list("sort=-premium,number");
		expect(page.items.map((item) => item.number)).toEqual([`${prefix}-a`, `${prefix}-b`, `${prefix}-c`]);
	});

	it("rejects undeclared, private and malformed queries with 400 before touching data", async () => {
		const routes = authorizedRoutes();
		const before = await countPolicies();
		const queries = [
			"filter[holder]=Ada",
			"filter[notes][null]=true",
			"sort=holder",
			"sort=-notes",
			"filter[status][gt]=a",
			"filter[premium]=abc",
			"filter[premium]=1e3",
			"filter[premium][in]=",
			"filter=status='active'",
			"filter[status][eq][x]=active",
			`filter[${encodeURIComponent("status) or 1=1 --")}]=x`,
			`sort=${encodeURIComponent("created; drop table policies")}`,
			"sort=created,created",
			"sort=created,updated,number,premium",
			"sort=number&sort=created",
			`filter[premium][in]=${Array.from({ length: 51 }, (_, i) => i).join(",")}`,
			[
				"filter[premium]=1",
				"filter[premium][ne]=1",
				"filter[premium][gt]=1",
				"filter[premium][gte]=1",
				"filter[premium][lt]=1",
				"filter[premium][lte]=1",
				"filter[premium][in]=1",
				"filter[premium][null]=false",
				"filter[status]=active",
				"filter[number]=x",
				"filter[agent_id]=y",
			].join("&"),
			"perPage=101",
			"page=0",
		];
		for (const query of queries) {
			const response = await routes.request(`${base}?${query}`);
			expect(response.status, query).toBe(400);
			expect(((await response.json()) as ErrorEnvelope).error.code, query).toBe("bad_request");
		}
		expect(await countPolicies()).toBe(before);
	});

	it("treats injection attempts in values as data", async () => {
		const { list } = await seed([{ status: "active" }]);
		const before = await countPolicies();
		for (const value of ["active' OR '1'='1", 'active"; DROP TABLE policies; --', "%", "*"]) {
			const page = await list(`filter[status]=${encodeURIComponent(value)}`);
			expect(page.totalItems, value).toBe(0);
		}
		expect((await list("filter[status][in]=active,x' or 1=1 --")).totalItems).toBe(1);
		expect(await countPolicies()).toBe(before);
	});

	it("filters a created range and allows the maximum page size", async () => {
		let tick = Date.parse("2032-01-01T00:00:00.000Z");
		const nextMinute = () => {
			tick += 60_000;
			return new Date(tick);
		};
		const { created, list } = await seed(
			Array.from({ length: 3 }, () => ({})),
			nextMinute,
		);
		const middle = created[1]?.created ?? "";
		const page = await list(`filter[created][gte]=${middle}&filter[created][lte]=${middle}&perPage=100`);
		expect(page.items.map((item) => item.id)).toEqual([created[1]?.id]);
		expect(page.perPage).toBe(100);
	});
});
