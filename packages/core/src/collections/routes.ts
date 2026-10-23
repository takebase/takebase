import { type CollectionOperation, type ErrorCode, errorStatus, type FieldErrors } from "@takebase/contracts";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { evaluateRule } from "../rules/evaluate.ts";
import type { AuthIdentity } from "../rules/types.ts";
import { createCollectionsService, recordExists } from "../services/collections-d1-service.ts";
import { type AnyD1Database, isConstraintError } from "../storage/d1.ts";
import type { CollectionDefinition } from "./define-collection.ts";
import type { CollectionRegistry } from "./registry.ts";
import { type DatabaseLookup, type ValidationMode, validate } from "./validation.ts";

// What a request needs from the Worker's composition root, read per request.
export type CollectionRequest = { db: AnyD1Database; auth: AuthIdentity | null; now: Date };

export type CollectionRoutesOptions = {
	registry: CollectionRegistry;
	resolve: () => CollectionRequest;
};

const defaultPerPage = 30;
const maxPerPage = 100;
const recordIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (c: Context, code: ErrorCode, message: string, fields?: FieldErrors) =>
	c.json({ error: { code, message, ...(fields ? { fields } : {}) } }, errorStatus[code] as ContentfulStatusCode);

class RequestError extends Error {
	readonly code: ErrorCode;
	constructor(code: ErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

const parsePositiveInt = (value: string | undefined, fallback: number, name: string) => {
	if (value === undefined) return fallback;
	if (!/^[1-9]\d{0,6}$/.test(value)) throw new RequestError("bad_request", `"${name}" must be a positive integer`);
	return Number(value);
};

const readBody = async (c: Context) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		throw new RequestError("bad_request", "Request body must be valid JSON");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new RequestError("bad_request", "Request body must be a JSON object");
	}
	return body;
};

// Mounts list/view/create/update/delete for every registered collection:
//   GET    /api/collections/:collection/records
//   GET    /api/collections/:collection/records/:id
//   POST   /api/collections/:collection/records
//   PATCH  /api/collections/:collection/records/:id
//   DELETE /api/collections/:collection/records/:id
// Order per request: known collection → rule → input (format, then unique/exists) → storage.
export const createCollectionRoutes = ({ registry, resolve }: CollectionRoutesOptions) => {
	const routes = new Hono();

	const authorize = async (c: Context, operation: CollectionOperation) => {
		const definition = registry.get(c.req.param("collection") ?? "");
		if (!definition) throw new RequestError("not_found", "Collection not found");
		const request = resolve();
		const decision = await evaluateRule(definition.rules, definition.name, operation, request.auth);
		if (!decision.allowed) {
			throw new RequestError(
				decision.code,
				decision.code === "unauthenticated" ? "Authentication required" : "Not allowed",
			);
		}
		return { definition, db: request.db, service: createCollectionsService(request.db, definition.table, request.now) };
	};

	const recordId = (c: Context) => {
		const id = c.req.param("id") ?? "";
		if (!recordIdPattern.test(id)) throw new RequestError("not_found", "Record not found");
		return id;
	};

	// `currentId` is the record being updated, which its own `unique` rules ignore.
	const lookupFor =
		(db: AnyD1Database, currentId?: string): DatabaseLookup =>
		async (_field, rule, value) => {
			const resolved = registry.lookup(rule);
			if (!resolved) throw new Error(`Unresolved "${rule.name}" rule`);
			const exceptId = resolved.ignoreCurrent ? currentId : undefined;
			const found = await recordExists(db, resolved.table, resolved.column, value, exceptId);
			return rule.name === "unique" ? !found : found;
		};

	const validated = async (
		c: Context,
		definition: CollectionDefinition,
		mode: ValidationMode,
		lookup: DatabaseLookup,
	) => {
		const result = await validate(await readBody(c), definition.validation, {
			mode,
			messages: definition.messages,
			attributes: definition.attributes,
			lookup,
		});
		if (!result.ok) return { error: fail(c, "validation_failed", "The given data was invalid.", result.fields) };
		return { data: result.data };
	};

	routes.get("/api/collections/:collection/records", async (c) => {
		const { service } = await authorize(c, "list");
		if (c.req.query("filter") !== undefined || c.req.query("sort") !== undefined) {
			throw new RequestError("bad_request", "Filtering and sorting are not supported yet");
		}
		const page = parsePositiveInt(c.req.query("page"), 1, "page");
		const perPage = parsePositiveInt(c.req.query("perPage"), defaultPerPage, "perPage");
		if (perPage > maxPerPage) throw new RequestError("bad_request", `"perPage" must be at most ${maxPerPage}`);
		return c.json(await service.list({ page, perPage }));
	});

	routes.get("/api/collections/:collection/records/:id", async (c) => {
		const { service } = await authorize(c, "view");
		const record = await service.view(recordId(c));
		return record ? c.json(record) : fail(c, "not_found", "Record not found");
	});

	routes.post("/api/collections/:collection/records", async (c) => {
		const { definition, db, service } = await authorize(c, "create");
		const input = await validated(c, definition, "create", lookupFor(db));
		if (input.error) return input.error;
		return c.json(await service.create(input.data), 201);
	});

	routes.patch("/api/collections/:collection/records/:id", async (c) => {
		const { definition, db, service } = await authorize(c, "update");
		const id = recordId(c);
		const input = await validated(c, definition, "update", lookupFor(db, id));
		if (input.error) return input.error;
		const record = await service.update(id, input.data);
		return record ? c.json(record) : fail(c, "not_found", "Record not found");
	});

	routes.delete("/api/collections/:collection/records/:id", async (c) => {
		const { service } = await authorize(c, "delete");
		return (await service.remove(recordId(c))) ? c.body(null, 204) : fail(c, "not_found", "Record not found");
	});

	// Stable envelopes for every failure; storage details never reach the client.
	routes.onError((error, c) => {
		if (error instanceof RequestError) return fail(c, error.code, error.message);
		if (isConstraintError(error)) return fail(c, "conflict", "The record conflicts with an existing record");
		return fail(c, "internal", "Internal error");
	});

	return routes;
};
