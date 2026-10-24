import type { CollectionRecord, FieldErrors } from "@takebase/contracts";
import type { AuthIdentity } from "../rules/types.ts";

// Laravel-style model events. Hooks run only after the rule allowed the
// operation and the input validated, so they can never widen access.
//
// - creating/updating/deleting run before the write. They receive data and
//   identity but no database or env, may transform the data or reject the
//   operation with a HookError, and must not cause external side effects:
//   the write after them can still fail.
// - created/updated/deleted run only after the write succeeded (Laravel's
//   afterCommit). That is the place for side effects; a failure there is
//   logged and never changes the committed response. The change's outbox
//   event is already committed with the write, so it never depends on them.

export type HookData = Record<string, unknown>;

export type HookContext = { readonly auth: AuthIdentity | null; readonly collection: string };
export type RecordHookContext = HookContext & { readonly id: string; readonly record: CollectionRecord };

type Awaitable<T> = T | Promise<T>;

// Returning nothing keeps the data unchanged.
export type CollectionHooks = {
	creating?(data: HookData, context: HookContext): Awaitable<HookData | undefined>;
	updating?(data: HookData, context: RecordHookContext): Awaitable<HookData | undefined>;
	deleting?(context: RecordHookContext): Awaitable<void>;
	created?(record: CollectionRecord, context: HookContext): Awaitable<void>;
	updated?(record: CollectionRecord, context: HookContext): Awaitable<void>;
	deleted?(context: RecordHookContext): Awaitable<void>;
};

export const hookNames = ["creating", "updating", "deleting", "created", "updated", "deleted"] as const;

export type HookErrorCode = "validation_failed" | "conflict" | "forbidden";

// Thrown by a before-hook to cancel the operation with a client error.
export class HookError extends Error {
	readonly code: HookErrorCode;
	readonly fields: FieldErrors | undefined;
	constructor(code: HookErrorCode, message: string, fields?: FieldErrors) {
		super(message);
		this.name = "HookError";
		this.code = code;
		this.fields = fields;
	}
}

// Checked once by defineCollection, so a typo never silently skips a hook.
export const checkHooks = (name: string, hooks: CollectionHooks | undefined) => {
	if (hooks === undefined) return Object.freeze({});
	for (const [key, hook] of Object.entries(hooks)) {
		if (!(hookNames as readonly string[]).includes(key))
			throw new Error(`Collection "${name}" has unknown hook "${key}"`);
		if (typeof hook !== "function") throw new Error(`Collection "${name}" hook "${key}" must be a function`);
	}
	return Object.freeze({ ...hooks });
};

const isPlainObject = (value: unknown): value is HookData =>
	typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

// A before-hook may only return client-writable fields; anything else
// (id, timestamps, unknown columns) is a programming error, not client input.
export const hookOutput = (
	name: string,
	hook: string,
	result: HookData | undefined,
	data: HookData,
	fields: string[],
) => {
	if (result === undefined) return data;
	if (!isPlainObject(result)) throw new Error(`Collection "${name}" hook "${hook}" must return a plain object`);
	const unknown = Object.keys(result).filter((field) => !fields.includes(field));
	if (unknown.length > 0) {
		throw new Error(`Collection "${name}" hook "${hook}" returned non-writable fields: ${unknown.join(", ")}`);
	}
	return result;
};

// Runs an after-hook; the write is already committed, so errors are only logged.
export const runAfterHook = async (name: string, hook: string, run: () => Awaitable<void>) => {
	try {
		await run();
	} catch (error) {
		console.error(`Collection "${name}" hook "${hook}" failed after the write`, error);
	}
};
