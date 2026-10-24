import { type CollectionClient, createClient, type Fetch, type FirebaseAuthLike } from "../src/index.ts";

export const globalUrl = "https://global.example";

// A stand-in for a Firebase Auth instance: `signIn` switches the current user
// and notifies listeners like onIdTokenChanged; tokens are `<uid>-token-<n>`,
// where n grows with every forced refresh.
export const fakeAuth = (initial: string | null = "user-1") => {
	let current = initial;
	let refreshes = 0;
	const listeners = new Set<(user: { uid: string } | null) => void>();
	const user = () =>
		current === null
			? null
			: {
					uid: current,
					getIdToken: async (force?: boolean) => {
						if (force) refreshes++;
						return `${current}-token-${refreshes}`;
					},
				};
	const signIn = (uid: string | null) => {
		current = uid;
		for (const listener of listeners) listener(uid === null ? null : { uid });
	};
	const auth: FirebaseAuthLike = {
		get currentUser() {
			return user();
		},
		onIdTokenChanged: (next) => {
			listeners.add(next);
			next(current === null ? null : { uid: current });
			return () => listeners.delete(next);
		},
		signOut: async () => signIn(null),
	};
	return { auth, signIn };
};

export const membership = (id: string, url: string, roles = ["member"]) => ({ tenant: { id, name: id, url }, roles });

// Answers tenant discovery from the global URL and passes every other request on.
export const withDiscovery =
	(tenants: ReturnType<typeof membership>[], fetch: Fetch): Fetch =>
	async (url, init) =>
		url === `${globalUrl}/api/tenants` ? Response.json({ tenants }) : fetch(url, init);

export const tenantClient = async (fetch: Fetch, url = "https://tenant.example") => {
	const client = createClient({
		globalUrl,
		auth: fakeAuth().auth,
		fetch: withDiscovery([membership("t1", url)], fetch),
	});
	await client.useTenant("t1");
	return client;
};

// A collection of a selected tenant, usable synchronously: each call waits for
// the selection first.
export const tenantCollection = <Fields extends object>(fetch: Fetch, name = "policies") => {
	const ready = tenantClient(fetch);
	const call =
		<Method extends keyof CollectionClient<Fields>>(method: Method) =>
		async (...args: Parameters<CollectionClient<Fields>[Method]>) => {
			const collection = (await ready).collection<Fields>(name);
			return (collection[method] as (...args: unknown[]) => unknown)(...args);
		};
	return {
		getList: call("getList"),
		view: call("view"),
		create: call("create"),
		update: call("update"),
		delete: call("delete"),
	} as unknown as CollectionClient<Fields>;
};
