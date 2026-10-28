import type {
	AdminCollection,
	CollectionClient,
	CollectionRecord,
	FieldErrors,
	ListEnvelope,
	SortField,
	TakebaseError,
} from "@takebase/sdk";
import { useEdge } from "#lib/edge.ts";
import { message, onReset } from "#lib/stores/session.svelte.ts";

// The selected tenant's collections (declarations from the admin API) and the
// records of one of them, through the SDK only: every read and write is
// decided by that collection's rules in the tenant Worker, and a refusal is
// shown as it came. One realtime subscription, for the open collection;
// cleared on every tenant switch and sign-out.
export const collections = $state({
	list: [] as AdminCollection[],
	loaded: false,
	open: null as AdminCollection | null,
	records: null as ListEnvelope<CollectionRecord> | null,
	page: 1,
	sort: "-created",
	realtime: {
		// Subscribed, and whether the first signal (the catch-up) arrived.
		subscribed: false,
		live: false,
		revision: 0,
		lastSignal: null as string | null,
		refetches: 0,
	},
	error: null as string | null,
	fields: {} as FieldErrors,
});

const perPage = 20;

// Changes on every clear or newly opened collection, so late answers are dropped.
let epoch = 0;
let handle: CollectionClient | null = null;
let unsubscribe: (() => void) | null = null;

const close = () => {
	epoch++;
	unsubscribe?.();
	unsubscribe = null;
	handle = null;
	collections.open = null;
	collections.records = null;
	collections.page = 1;
	collections.sort = "-created";
	collections.realtime = { subscribed: false, live: false, revision: 0, lastSignal: null, refetches: 0 };
	collections.error = null;
	collections.fields = {};
};

onReset(() => {
	close();
	collections.list = [];
	collections.loaded = false;
});

// The SDK's own answer to a tenant switch or sign-out during the request.
const changed = (error: unknown) => (error as TakebaseError | null)?.code === "tenant_changed";

const fail = (error: unknown) => {
	if (changed(error)) return;
	collections.error = message(error);
	collections.fields = (error as TakebaseError | null)?.fields ?? {};
};

export const loadCollections = async () => {
	const started = epoch;
	collections.error = null;
	try {
		const list = await useEdge().client.admin().collections();
		if (epoch !== started) return;
		collections.list = list;
		collections.loaded = true;
	} catch (error) {
		if (epoch === started) fail(error);
	}
};

const fetchPage = async () => {
	const started = epoch;
	const current = handle;
	if (!current) return;
	try {
		const records = await current.getList({
			page: collections.page,
			perPage,
			sort: collections.sort as SortField,
		});
		if (epoch === started) collections.records = records;
	} catch (error) {
		if (epoch === started) fail(error);
	}
};

// Opens one collection: reads its first page, and subscribes so every signal
// (which carries no records) refetches the page through the API.
export const openCollection = (name: string) => {
	close();
	const declared = collections.list.find((collection) => collection.name === name) ?? null;
	if (!declared) return;
	const started = epoch;
	collections.open = declared;
	collections.sort = declared.sorts.includes("created") ? "-created" : (declared.sorts[0] ?? "");
	handle = useEdge().client.collection(name);
	try {
		unsubscribe = handle.subscribe("*", ({ revision }) => {
			if (epoch !== started) return;
			collections.realtime.live = true;
			collections.realtime.revision = revision;
			collections.realtime.lastSignal = new Date().toLocaleTimeString();
			collections.realtime.refetches++;
			void fetchPage();
		});
		collections.realtime.subscribed = true;
	} catch (error) {
		fail(error);
	}
	void fetchPage();
};

// Leaving the screen ends its subscription.
export const closeCollection = close;

export const goToPage = (page: number) => {
	collections.page = page;
	void fetchPage();
};

export const sortBy = (sort: string) => {
	collections.sort = sort;
	collections.page = 1;
	void fetchPage();
};

// Form text to the field's declared type: integer/numeric become numbers, and
// an empty nullable field becomes null.
const parse = (data: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(data).map(([name, text]) => {
			const rules = collections.open?.fields.find((field) => field.name === name)?.rules ?? [];
			if (text === "" && rules.includes("nullable")) return [name, null];
			if ((rules.includes("integer") || rules.includes("numeric")) && text.trim() !== "") return [name, Number(text)];
			return [name, text];
		}),
	);

// Runs one write; true when the Worker accepted it. The page refreshes now
// and again when the change's realtime signal arrives.
const write = async (send: (current: CollectionClient) => Promise<unknown>) => {
	const started = epoch;
	const current = handle;
	if (!current) return false;
	collections.error = null;
	collections.fields = {};
	try {
		await send(current);
		if (epoch !== started) return false;
		await fetchPage();
		return true;
	} catch (error) {
		if (epoch === started) fail(error);
		return false;
	}
};

export const createRecord = (data: Record<string, string>) => write((current) => current.create(parse(data)));

export const updateRecord = (id: string, data: Record<string, string>) =>
	write((current) => current.update(id, parse(data)));

export const deleteRecord = (id: string) => write((current) => current.delete(id));
