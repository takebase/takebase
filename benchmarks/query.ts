import { measure, type Sizes, type Stats, send, status, type Target } from "./lib.ts";

// List queries, each with its count, as the API runs them. `rows` is what the
// table holds at the time, reported in each name.

const records = "/api/collections/policies/records";
const perPage = 30;

export const benchmarkQueries = async (target: Target, sizes: Sizes): Promise<Stats[]> => {
	const first = await send(target, `${records}?perPage=1`);
	if (first.status !== 200) throw new Error(`Listing policies answered HTTP ${first.status}`);
	const { totalItems } = (await first.json()) as { totalItems: number };
	const lastPage = Math.max(1, Math.ceil(totalItems / perPage));
	const queries = {
		"default order": `perPage=${perPage}`,
		"filter and sort": `perPage=${perPage}&filter[status]=active&sort=-premium`,
		"range filter": `perPage=${perPage}&filter[premium][gte]=2500&sort=premium`,
		"deepest page": `perPage=${perPage}&page=${lastPage}`,
	};
	const results: Stats[] = [];
	for (const concurrency of sizes.concurrencies) {
		for (const [name, query] of Object.entries(queries)) {
			results.push(
				await measure(`list: ${name} (${totalItems} rows)`, { concurrency, count: sizes.query, expected: 200 }, () =>
					status(target, `${records}?${query}`),
				),
			);
		}
	}
	return results;
};
