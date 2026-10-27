import { type CollectionOperation, type ErrorCode, errorStatus, type FieldErrors } from "@takebase/contracts";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "../diagnostics/log.ts";
import { evaluateRule } from "../rules/evaluate.ts";
import type { AuthIdentity } from "../rules/types.ts";
import { createCollectionsService, recordExists } from "../services/collections-d1-service.ts";
import { type AnyD1Database, isConstraintError } from "../storage/d1.ts";
import type { CollectionDefinition } from "./define-collection.ts";
import { type HookContext, type HookData, HookError, hookOutput, runAfterHook } from "./hooks.ts";
import { ListQueryError, parseListQuery } from "./query.ts";
import type { CollectionRegistry } from "./registry.ts";
import { type DatabaseLookup, type ValidationMode, validate } from "./validation.ts";

// What a request needs from the Worker's composition root, read per request.
export type CollectionRequest = {
	db: AnyD1Database;
	auth: AuthIdentity | null;
	now: Date;
	// The request's redacted logger; defaults to an unscoped one.
	log?: Logger;
};

export type CollectionRoutesOptions = {
	registry: CollectionRegistry;
	resolve: () => CollectionRequest;
	// Runs after a create/update/delete committed (with its outbox event); the
	// Worker uses it to dispatch realtime signals without waiting for them.
	committed?: () => void;
};

const recordIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (c: Context, code: ErrorCode, message: string, fields?: FieldErrors) =>
	c.json({ error: { code, message, ...(fields ? { fields } : {}) } }, errorStatus[code] as ContentfulStatusCode);

class RequestError extends Error {
	readonly code: ErrorCode;
	readonly fields: FieldErrors | undefined;
	constructor(code: ErrorCode, message: string, fields?: FieldErrors) {
		super(message);
		this.code = code;
		this.fields = fields;
	}
}

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
// Order per request: known collection → rule → input (format, then unique/exists)
// → before-hook → its output validated again → storage → after-hook.
export const createCollectionRoutes = ({ registry, resolve, committed }: CollectionRoutesOptions) => {
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
		const context: HookContext = Object.freeze({ auth: request.auth, collection: definition.name });
		const service = createCollectionsService(request.db, definition.table, definition.name, request.now);
		return { definition, db: request.db, service, context, log: request.log };
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
		input: unknown,
		definition: CollectionDefinition,
		mode: ValidationMode,
		lookup: DatabaseLookup,
	) => {
		const result = await validate(input, definition.validation, {
			mode,
			messages: definition.messages,
			attributes: definition.attributes,
			lookup,
		});
		if (!result.ok) throw new RequestError("validation_failed", "The given data was invalid.", result.fields);
		return result.data;
	};

	// A before-hook's output is validated again with the same rules, so a hook
	// can never store what a client could not.
	const beforeWrite = async (
		definition: CollectionDefinition,
		hook: "creating" | "updating",
		data: HookData,
		lookup: DatabaseLookup,
		run: (input: HookData) => Promise<HookData | undefined> | HookData | undefined,
	) => {
		const input = { ...data };
		const output = hookOutput(definition.name, hook, await run(input), input, Object.keys(definition.validation));
		return validated(output, definition, hook === "creating" ? "create" : "update", lookup);
	};

	routes.get("/api/collections/:collection/records", async (c) => {
		const { definition, service } = await authorize(c, "list");
		return c.json(await service.list(parseListQuery(new URL(c.req.url).searchParams, definition.list)));
	});

	routes.get("/api/collections/:collection/records/:id", async (c) => {
		const { service } = await authorize(c, "view");
		const record = await service.view(recordId(c));
		return record ? c.json(record) : fail(c, "not_found", "Record not found");
	});

	routes.post("/api/collections/:collection/records", async (c) => {
		const { definition, db, service, context, log } = await authorize(c, "create");
		const { hooks } = definition;
		const lookup = lookupFor(db);
		let data = await validated(await readBody(c), definition, "create", lookup);
		if (hooks.creating)
			data = await beforeWrite(definition, "creating", data, lookup, (input) => hooks.creating?.(input, context));
		const record = await service.create(data);
		committed?.();
		if (hooks.created) await runAfterHook(definition.name, "created", () => hooks.created?.(record, context), log);
		return c.json(record, 201);
	});

	routes.patch("/api/collections/:collection/records/:id", async (c) => {
		const { definition, db, service, context, log } = await authorize(c, "update");
		const { hooks } = definition;
		const id = recordId(c);
		const lookup = lookupFor(db, id);
		let data = await validated(await readBody(c), definition, "update", lookup);
		if (hooks.updating) {
			const current = await service.view(id);
			if (!current) return fail(c, "not_found", "Record not found");
			const recordContext = { ...context, id, record: current };
			data = await beforeWrite(definition, "updating", data, lookup, (input) => hooks.updating?.(input, recordContext));
		}
		const record = await service.update(id, data);
		if (!record) return fail(c, "not_found", "Record not found");
		committed?.();
		if (hooks.updated) await runAfterHook(definition.name, "updated", () => hooks.updated?.(record, context), log);
		return c.json(record);
	});

	routes.delete("/api/collections/:collection/records/:id", async (c) => {
		const { definition, service, context, log } = await authorize(c, "delete");
		const { hooks } = definition;
		const id = recordId(c);
		if (!hooks.deleting && !hooks.deleted) {
			if (!(await service.remove(id))) return fail(c, "not_found", "Record not found");
			committed?.();
			return c.body(null, 204);
		}
		const current = await service.view(id);
		if (!current) return fail(c, "not_found", "Record not found");
		const recordContext = { ...context, id, record: current };
		await hooks.deleting?.(recordContext);
		if (!(await service.remove(id))) return fail(c, "not_found", "Record not found");
		committed?.();
		if (hooks.deleted) await runAfterHook(definition.name, "deleted", () => hooks.deleted?.(recordContext), log);
		return c.body(null, 204);
	});

	// Stable envelopes for every failure; storage details never reach the client.
	routes.onError((error, c) => {
		if (error instanceof RequestError || error instanceof HookError)
			return fail(c, error.code, error.message, error.fields);
		if (error instanceof ListQueryError) return fail(c, "bad_request", error.message);
		if (isConstraintError(error)) return fail(c, "conflict", "The record conflicts with an existing record");
		resolve().log?.error("collection.internal_error", { method: c.req.method, error });
		return fail(c, "internal", "Internal error");
	});

	return routes;
};
