import { type CollectionClient, createCollectionClient } from "./collection.ts";
import { createHttp, type Fetch } from "./http.ts";

export type ClientOptions = {
	// The tenant Worker's origin, e.g. "https://tenant.example.com".
	url: string;
	// Defaults to the global fetch.
	fetch?: Fetch;
};

export type TakebaseClient = {
	collection: <Fields extends object = Record<string, unknown>>(name: string) => CollectionClient<Fields>;
};

export const createClient = ({
	url,
	fetch = (input, init) => globalThis.fetch(input, init),
}: ClientOptions): TakebaseClient => {
	const http = createHttp(url, fetch);
	return { collection: (name) => createCollectionClient(http, name) };
};
