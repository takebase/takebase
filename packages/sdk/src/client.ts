import type { TenantMembership } from "@takebase/contracts";
import { type FirebaseAuthLike, safeBaseUrl, tokenSource } from "./auth.ts";
import { type CollectionClient, createCollectionClient } from "./collection.ts";
import { TakebaseError } from "./errors.ts";
import { createHttp, type Fetch, type Http, type RequestOptions } from "./http.ts";
import { fetchTenants } from "./tenant.ts";

export type ClientOptions = {
	// The global Worker's origin, e.g. "https://auth.example.com".
	globalUrl: string;
	// The application's Firebase Auth instance (`getAuth()`), already set up for sign-in.
	auth: FirebaseAuthLike;
	// Defaults to the global fetch.
	fetch?: Fetch;
};

export type TakebaseClient = {
	auth: {
		// The tenants the signed-in user belongs to, fresh from the global Worker.
		getTenants: (options?: RequestOptions) => Promise<TenantMembership[]>;
		// Signs out of Firebase and forgets the selected tenant.
		signOut: () => Promise<void>;
	};
	// Selects a tenant the global Worker lists for this user; its URL comes from
	// that answer, never from the caller.
	useTenant: (id: string, options?: RequestOptions) => Promise<TenantMembership>;
	// The selected tenant, or null.
	tenant: () => TenantMembership | null;
	// CRUD for one collection of the selected tenant. The handle stays bound to
	// that tenant and rejects with `tenant_changed` after a switch or sign-out.
	collection: <Fields extends object = Record<string, unknown>>(name: string) => CollectionClient<Fields>;
	// Stops following Firebase user changes.
	close: () => void;
};

type Selection = { membership: TenantMembership; http: Http; generation: number };

export const createClient = ({
	globalUrl,
	auth,
	fetch = (input, init) => globalThis.fetch(input, init),
}: ClientOptions): TakebaseClient => {
	const globalBase = safeBaseUrl(globalUrl);
	if (globalBase === null) throw new TypeError("globalUrl must be an https URL (http only for localhost)");
	const token = tokenSource(auth);
	const global = createHttp(globalBase, fetch, token);

	// Per-client state only: nothing is shared between clients or users.
	// `generation` changes whenever the selected tenant or the user changes.
	let generation = 0;
	let selection: Selection | null = null;
	let uid = auth.currentUser?.uid ?? null;

	const reset = () => {
		generation++;
		selection = null;
	};

	const unsubscribe = auth.onIdTokenChanged((user) => {
		const next = user?.uid ?? null;
		if (next === uid) return;
		uid = next;
		reset();
	});

	const changed = () => new TakebaseError(0, "tenant_changed", "The selected tenant or user changed");

	const useTenant = async (id: string, options?: RequestOptions) => {
		const started = generation;
		const tenants = await fetchTenants(global, options);
		if (generation !== started) throw changed();
		const membership = tenants.find(({ tenant }) => tenant.id === id);
		if (!membership) throw new TakebaseError(403, "forbidden", "Not a member of this tenant");
		const base = safeBaseUrl(membership.tenant.url);
		if (base === null) throw new TakebaseError(0, "invalid_response", "The tenant URL is not an https URL");
		reset();
		selection = { membership, http: createHttp(base, fetch, token), generation };
		return membership;
	};

	const collection = <Fields extends object>(name: string) => {
		const bound = selection;
		if (bound === null) throw new Error("Select a tenant with useTenant() before using collections");
		const http: Http = {
			send: (path, request) =>
				bound.generation === generation ? bound.http.send(path, request) : Promise.reject(changed()),
		};
		return createCollectionClient<Fields>(http, name);
	};

	return {
		auth: {
			getTenants: (options) => fetchTenants(global, options),
			signOut: async () => {
				reset();
				await auth.signOut();
			},
		},
		useTenant,
		tenant: () => selection?.membership ?? null,
		collection,
		close: unsubscribe,
	};
};
