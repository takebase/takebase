import {
	type CollectionRecord,
	type CreateInput,
	isListEnvelope,
	type ListEnvelope,
	type ListQuery,
	toListSearchParams,
	type UpdateInput,
} from "@takebase/contracts";
import { readResponse, TakebaseError } from "./errors.ts";
import type { Http, RequestOptions } from "./http.ts";

export type CollectionClient<Fields extends object = Record<string, unknown>> = {
	getList: (query?: ListQuery<Fields>, options?: RequestOptions) => Promise<ListEnvelope<CollectionRecord<Fields>>>;
	view: (id: string, options?: RequestOptions) => Promise<CollectionRecord<Fields>>;
	create: (data: CreateInput<Fields>, options?: RequestOptions) => Promise<CollectionRecord<Fields>>;
	update: (id: string, data: UpdateInput<Fields>, options?: RequestOptions) => Promise<CollectionRecord<Fields>>;
	delete: (id: string, options?: RequestOptions) => Promise<void>;
};

const namePattern = /^[a-z][a-z0-9_]{0,62}$/;

const isRecord = (value: unknown): value is CollectionRecord => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return typeof record.id === "string" && typeof record.created === "string" && typeof record.updated === "string";
};

const invalid = (response: Response, what: string) =>
	new TakebaseError(response.status, "invalid_response", `Response is not a ${what}`);

const readRecord = async <Fields extends object>(response: Response) => {
	const body = await readResponse<unknown>(response);
	if (!isRecord(body)) throw invalid(response, "record");
	return body as CollectionRecord<Fields>;
};

const readList = async <Fields extends object>(response: Response) => {
	const body = await readResponse<unknown>(response);
	if (!isListEnvelope(body) || !body.items.every(isRecord)) throw invalid(response, "list of records");
	return body as ListEnvelope<CollectionRecord<Fields>>;
};

// CRUD for one collection at `/api/collections/<name>/records`. Access is
// decided by the Worker's rules; nothing here grants or checks permissions.
export const createCollectionClient = <Fields extends object>(http: Http, name: string): CollectionClient<Fields> => {
	if (!namePattern.test(name)) throw new TypeError(`Invalid collection name "${name}"`);
	const records = `/api/collections/${name}/records`;
	const record = (id: string) => `${records}/${encodeURIComponent(id)}`;

	return {
		getList: async (query = {}, { signal } = {}) =>
			readList<Fields>(await http.send(records, { method: "GET", query: toListSearchParams(query), signal })),
		view: async (id, { signal } = {}) => readRecord<Fields>(await http.send(record(id), { method: "GET", signal })),
		create: async (data, { signal } = {}) =>
			readRecord<Fields>(await http.send(records, { method: "POST", body: data, signal })),
		update: async (id, data, { signal } = {}) =>
			readRecord<Fields>(await http.send(record(id), { method: "PATCH", body: data, signal })),
		delete: async (id, { signal } = {}) => {
			const response = await http.send(record(id), { method: "DELETE", signal });
			if (response.status !== 204) await readResponse(response);
		},
	};
};
