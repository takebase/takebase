import type { CollectionRecord, TakebaseError } from "@takebase/sdk";
import { useEdge } from "#lib/edge.ts";

export type PolicyFields = {
	number: string;
	holder: string;
	status: "pending" | "active" | "cancelled";
	agent_id?: string | null;
	premium?: number | null;
	notes?: string | null;
};

export type Policy = CollectionRecord<PolicyFields>;

// The selected tenant's policies, always fetched through the API (the
// collection rules decide what comes back). Nothing is persisted.
export const policies = $state({
	items: [] as Policy[],
	total: 0,
	loading: false,
	error: null as string | null,
});

// Every load and reset takes a new number; only the latest load may write, so a
// slow response from before a tenant switch or sign-out is dropped.
let latest = 0;

export const resetPolicies = () => {
	latest++;
	policies.items = [];
	policies.total = 0;
	policies.loading = false;
	policies.error = null;
};

const isStale = (error: unknown) => (error as TakebaseError | null)?.code === "tenant_changed";

export const loadPolicies = async () => {
	const request = ++latest;
	policies.loading = true;
	try {
		const page = await useEdge().client.collection<PolicyFields>("policies").getList({ sort: "-created", perPage: 50 });
		if (request !== latest) return;
		policies.items = page.items;
		policies.total = page.totalItems;
		policies.error = null;
	} catch (error) {
		if (request !== latest || isStale(error)) return;
		policies.error = error instanceof Error ? error.message : String(error);
	} finally {
		if (request === latest) policies.loading = false;
	}
};

// The list is not refetched here: the committed write's realtime signal does it.
export const createPolicy = (fields: PolicyFields) =>
	useEdge().client.collection<PolicyFields>("policies").create(fields);
