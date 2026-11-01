import { measure, type Sizes, type Stats, send, status, type Target } from "./lib.ts";

// Create, view and update on `policies`, the auth paths, and liveness as the
// floor. Policies deny every delete through the API, so there is no delete to
// measure; run.ts removes the records with SQL afterwards.

const records = "/api/collections/policies/records";

export const benchmarkCrud = async (target: Target, sizes: Sizes, run: string): Promise<Stats[]> => {
	const results: Stats[] = [];
	for (const concurrency of sizes.concurrencies) {
		const ids: string[] = [];
		results.push(
			await measure("liveness (no auth, one D1 read)", { concurrency, count: sizes.health, expected: 200 }, () =>
				status(target, "/health", {}, null),
			),
		);
		results.push(
			await measure("invalid token refused", { concurrency, count: sizes.health, expected: 401 }, () =>
				status(target, records, {}, "not-a-token"),
			),
		);
		results.push(
			await measure("create", { concurrency, count: sizes.crud, expected: 201 }, async (index) => {
				const response = await send(target, records, {
					method: "POST",
					body: JSON.stringify({
						number: `BENCH-${run}-${concurrency}-${index}`,
						holder: "Benchmark Holder",
						status: "pending",
						premium: index,
					}),
				});
				const { id } = (await response.json()) as { id?: string };
				if (id !== undefined) ids.push(id);
				return response.status;
			}),
		);
		if (ids.length === 0) throw new Error("No record was created; the remaining operations have nothing to read");
		results.push(
			await measure("view (membership check + D1 read)", { concurrency, count: sizes.crud, expected: 200 }, (index) =>
				status(target, `${records}/${ids[index % ids.length]}`),
			),
		);
		results.push(
			await measure("update", { concurrency, count: sizes.crud, expected: 200 }, (index) =>
				status(target, `${records}/${ids[index % ids.length]}`, {
					method: "PATCH",
					body: JSON.stringify({ status: "active" }),
				}),
			),
		);
	}
	return results;
};
