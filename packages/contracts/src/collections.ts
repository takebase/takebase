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

export const maxPerPage = 100;

// Comparison operators a collection may allow per field. `in` takes several
// values; `null: true` matches missing values and `null: false` present ones.
export const filterOperators = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "null"] as const;

export type FilterOperator = (typeof filterOperators)[number];

export type FilterValue = string | number | boolean;

// A bare value means `eq`, and a bare `null` means `{ null: true }`.
export type FieldFilter<Value> =
	| Value
	| null
	| {
			eq?: Value;
			ne?: Value;
			gt?: Value;
			gte?: Value;
			lt?: Value;
			lte?: Value;
			in?: readonly Value[];
			null?: boolean;
	  };

type FilterableValue<Value> = Extract<NonNullable<Value>, FilterValue>;

// Every condition must hold. Only fields the collection allows are accepted.
export type ListFilter<Fields extends object = Record<string, unknown>> = {
	[Field in keyof (RecordBase & Fields) & string]?: FieldFilter<FilterableValue<(RecordBase & Fields)[Field]>>;
};

// A field name sorts ascending; a leading "-" sorts descending.
export type SortField<Fields extends object = Record<string, unknown>> =
	| (keyof (RecordBase & Fields) & string)
	| `-${keyof (RecordBase & Fields) & string}`;

export type ListQuery<Fields extends object = Record<string, unknown>> = {
	page?: number;
	perPage?: number;
	sort?: SortField<Fields> | readonly SortField<Fields>[];
	filter?: ListFilter<Fields>;
};

// The list query string: `page`, `perPage`, `sort=-created,number`,
// `filter[status]=active` and `filter[premium][gte]=100`.
export const toListSearchParams = <Fields extends object>(query: ListQuery<Fields> = {}) => {
	const params = new URLSearchParams();
	const sort = query.sort as string | readonly string[] | undefined;
	if (query.page !== undefined) params.set("page", String(query.page));
	if (query.perPage !== undefined) params.set("perPage", String(query.perPage));
	if (sort !== undefined) params.set("sort", typeof sort === "string" ? sort : sort.join(","));
	for (const [field, filter] of Object.entries(query.filter ?? {}) as [string, FieldFilter<FilterValue>][]) {
		if (filter === undefined) continue;
		if (filter === null) params.set(`filter[${field}][null]`, "true");
		else if (typeof filter !== "object") params.set(`filter[${field}]`, String(filter));
		else {
			for (const [operator, value] of Object.entries(filter)) {
				if (value === undefined) continue;
				params.set(`filter[${field}][${operator}]`, Array.isArray(value) ? value.join(",") : String(value));
			}
		}
	}
	return params;
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
