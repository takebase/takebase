// Collection records, list pages and the CRUD operations a collection rule governs.

export const collectionOperations = ["list", "view", "create", "update", "delete"] as const;

export type CollectionOperation = (typeof collectionOperations)[number];

// Fields every record carries; timestamps are ISO 8601 strings.
export type RecordBase = {
	id: string;
	created: string;
	updated: string;
};

export type CollectionRecord<Fields extends object = Record<string, unknown>> = RecordBase & Fields;

// Client-writable fields: the server owns `id`, `created` and `updated`.
export type CreateInput<Fields extends object> = Fields;
export type UpdateInput<Fields extends object> = Partial<Fields>;

export type ListQuery = {
	page?: number;
	perPage?: number;
	sort?: string;
	filter?: string;
};

export type ListEnvelope<Item> = {
	items: Item[];
	page: number;
	perPage: number;
	totalItems: number;
	totalPages: number;
};

const isCount = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;

export const isListEnvelope = (value: unknown): value is ListEnvelope<unknown> => {
	if (typeof value !== "object" || value === null) return false;
	const list = value as Record<string, unknown>;
	return (
		Array.isArray(list.items) &&
		isCount(list.page) &&
		isCount(list.perPage) &&
		isCount(list.totalItems) &&
		isCount(list.totalPages)
	);
};
