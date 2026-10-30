import type { InviteRedemption, TenantMembership } from "@takebase/contracts";
import { createTenantAdministration, type TenantAdministration } from "./admin.ts";
import { type FirebaseAuthLike, safeBaseUrl, tokenSource } from "./auth.ts";
import { createBackupsClient, type TenantBackupsClient } from "./backups.ts";
import { type CollectionClient, createCollectionClient } from "./collection.ts";
import { createDiagnosticsClient, type TenantDiagnosticsClient } from "./diagnostics.ts";
import { TakebaseError } from "./errors.ts";
import { createHttp, type Fetch, type Http, type RequestOptions } from "./http.ts";
import { createTenantRealtime, type RealtimeOptions, type TenantRealtime } from "./realtime.ts";
import { createSecretsClient, type TenantSecretsClient } from "./secret-status.ts";
import type { SubscriptionCallback } from "./subscription.ts";
import { fetchTenants, redeemInvite } from "./tenant.ts";

export type ClientOptions = {
	// The global Worker's origin, e.g. "https://auth.example.com".
	globalUrl: string;
	// The application's Firebase Auth instance (`getAuth()`), already set up for sign-in.
	auth: FirebaseAuthLike;
	// Defaults to the global fetch.
	fetch?: Fetch;
	// Enables `subscribe` on collections.
	realtime?: RealtimeOptions;
};

// Why the SDK signed the user out: the app asked, or the tenant's API no longer
// accepts the user (removed, or the tenant disabled).
export type SignOutReason = "signed_out" | "access_revoked";

export type TakebaseClient = {
	auth: {
		// The tenants the signed-in user belongs to, fresh from the global Worker.
		getTenants: (options?: RequestOptions) => Promise<TenantMembership[]>;
		// Signs out of Firebase, closes realtime and forgets the selected tenant.
		signOut: () => Promise<void>;
		// Called after every SDK sign-out; clear all application state there.
		// Returns a function that stops listening.
		onSignedOut: (listener: (reason: SignOutReason) => void) => () => void;
	};
	invites: {
		// Redeems a single-use invitation token for the signed-in user's new role.
		redeem: (token: string, options?: RequestOptions) => Promise<InviteRedemption>;
	};
	// Selects a tenant the global Worker lists for this user; its URL comes from
	// that answer, never from the caller.
	useTenant: (id: string, options?: RequestOptions) => Promise<TenantMembership>;
	// The selected tenant, or null.
	tenant: () => TenantMembership | null;
	// CRUD and realtime for one collection of the selected tenant. The handle
	// stays bound to that tenant and rejects with `tenant_changed` after a switch
	// or sign-out; its subscriptions end then.
	collection: <Fields extends object = Record<string, unknown>>(name: string) => CollectionClient<Fields>;
	// Administration and diagnostics of the selected tenant, for its admins: the
	// Workers refuse everyone else. Bound to that tenant like `collection`.
	admin: () => AdminClient;
	// Stops following Firebase user changes and closes realtime.
	close: () => void;
};

export type AdminClient = TenantAdministration & TenantDiagnosticsClient & TenantSecretsClient & TenantBackupsClient;

type Selection = { membership: TenantMembership; http: Http; generation: number; realtime: TenantRealtime | null };

export const createClient = ({
	globalUrl,
	auth,
	fetch = (input, init) => globalThis.fetch(input, init),
	realtime,
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
	const signedOut = new Set<(reason: SignOutReason) => void>();

	const reset = () => {
		generation++;
		selection?.realtime?.close();
		selection = null;
	};

	const unsubscribe = auth.onIdTokenChanged((user) => {
		const next = user?.uid ?? null;
		if (next === uid) return;
		uid = next;
		reset();
	});

	const signOut = async (reason: SignOutReason) => {
		reset();
		await auth.signOut();
		for (const listener of signedOut) {
			try {
				listener(reason);
			} catch (error) {
				console.error("Sign-out listener failed", error);
			}
		}
	};

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
		selection = { membership, http: createHttp(base, fetch, token), generation, realtime: null };
		return membership;
	};

	// The selected tenant, and an Http that only sends while it stays selected.
	const bind = (what: string) => {
		const bound = selection;
		if (bound === null) throw new Error(`Select a tenant with useTenant() before using ${what}`);
		const current = () => bound.generation === generation;
		const guard = (target: Http): Http => ({
			send: (path, request) => (current() ? target.send(path, request) : Promise.reject(changed())),
		});
		return { bound, current, guard, http: guard(bound.http) };
	};

	const admin = (): AdminClient => {
		const { bound, guard, http } = bind("administration");
		const tenantGlobal = guard(global);
		const diagnostics = createDiagnosticsClient(tenantGlobal, http);
		const secrets = createSecretsClient(http);
		return {
			...createTenantAdministration(tenantGlobal, http, bound.membership.tenant.id),
			...diagnostics,
			...secrets,
			...createBackupsClient(tenantGlobal, bound.membership.tenant.id, { ...diagnostics, ...secrets }),
		};
	};

	const collection = <Fields extends object>(name: string) => {
		const { bound, current, http } = bind("collections");
		// Revocation is a full sign-out, even when the user has other tenants:
		// nothing from the revoked tenant stays in the app.
		const subscribe = (collection: string, callback: SubscriptionCallback) => {
			if (!realtime) throw new Error("Pass a realtime connector to createClient() to subscribe");
			if (!current()) throw changed();
			bound.realtime ??= createTenantRealtime({
				...realtime,
				http,
				revoked: () => {
					if (current()) void signOut("access_revoked");
				},
			});
			return bound.realtime.subscribe(collection, callback);
		};
		return createCollectionClient<Fields>(http, name, subscribe);
	};

	return {
		auth: {
			getTenants: (options) => fetchTenants(global, options),
			signOut: () => signOut("signed_out"),
			onSignedOut: (listener) => {
				signedOut.add(listener);
				return () => signedOut.delete(listener);
			},
		},
		invites: { redeem: (invite, options) => redeemInvite(global, invite, options) },
		useTenant,
		tenant: () => selection?.membership ?? null,
		collection,
		admin,
		close: () => {
			unsubscribe();
			reset();
		},
	};
};
