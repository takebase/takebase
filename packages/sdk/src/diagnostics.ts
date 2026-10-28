import type {
	AdminCollection,
	OutboxRetryRequest,
	OutboxRetryResult,
	Readiness,
	TenantDiagnostics,
} from "@takebase/contracts";
import { readResponse, TakebaseError } from "./errors.ts";
import type { Http, RequestOptions } from "./http.ts";

// Outbox diagnostics and repair of the selected tenant's Worker, for that
// tenant's admins (the Worker decides), and both Workers' readiness.
export type TenantDiagnosticsClient = {
	diagnostics: (options?: RequestOptions) => Promise<TenantDiagnostics>;
	// Moves dead events back to pending: by id (at most 50), or all of them.
	retryOutbox: (request: OutboxRetryRequest, options?: RequestOptions) => Promise<OutboxRetryResult>;
	// `/health/ready` of the global or the tenant Worker. A not-ready Worker
	// answers 503 with its checks, which resolve here too.
	readiness: (target: "global" | "tenant", options?: RequestOptions) => Promise<Readiness>;
	// How the tenant's collections are declared (fields, filters, sorts and each
	// operation's rule name), never their records.
	collections: (options?: RequestOptions) => Promise<AdminCollection[]>;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isDiagnostics = (value: unknown): value is TenantDiagnostics => {
	if (!isObject(value) || typeof value.tenantId !== "string" || !isObject(value.outbox)) return false;
	const { counts, dead } = value.outbox;
	return (
		isObject(counts) &&
		["pending", "delivered", "dead"].every((key) => typeof counts[key] === "number") &&
		Array.isArray(dead) &&
		Array.isArray(value.migrations) &&
		value.migrations.every((name) => typeof name === "string") &&
		typeof value.realtime === "boolean"
	);
};

const isReadiness = (value: unknown): value is Readiness =>
	isObject(value) &&
	typeof value.service === "string" &&
	["ok", "degraded", "error"].includes(value.status as string) &&
	isObject(value.checks);

const operations = ["list", "view", "create", "update", "delete"];
const isNames = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
const isCollection = (value: unknown): value is AdminCollection =>
	isObject(value) &&
	typeof value.name === "string" &&
	isObject(value.rules) &&
	operations.every((operation) => {
		const rule = (value.rules as Record<string, unknown>)[operation];
		return rule === null || typeof rule === "string";
	}) &&
	Array.isArray(value.fields) &&
	value.fields.every((field) => isObject(field) && typeof field.name === "string" && isNames(field.rules)) &&
	isObject(value.filters) &&
	Object.values(value.filters).every(isNames) &&
	isNames(value.sorts);

const invalid = (response: Response, what: string) =>
	new TakebaseError(response.status, "invalid_response", `Response is not ${what}`);

export const createDiagnosticsClient = (global: Http, tenant: Http): TenantDiagnosticsClient => ({
	diagnostics: async ({ signal } = {}) => {
		const response = await tenant.send("/api/admin/diagnostics", { method: "GET", signal });
		const body = await readResponse<unknown>(response);
		if (!isDiagnostics(body)) throw invalid(response, "tenant diagnostics");
		return body;
	},
	retryOutbox: async (request, { signal } = {}) => {
		const response = await tenant.send("/api/admin/outbox/retry", { method: "POST", body: request, signal });
		const body = await readResponse<unknown>(response);
		if (!isObject(body) || typeof body.revived !== "number") throw invalid(response, "an outbox retry result");
		return { revived: body.revived };
	},
	collections: async ({ signal } = {}) => {
		const response = await tenant.send("/api/admin/collections", { method: "GET", signal });
		const body = await readResponse<unknown>(response);
		const collections = isObject(body) ? body.collections : undefined;
		if (!Array.isArray(collections) || !collections.every(isCollection)) {
			throw invalid(response, "a list of collections");
		}
		return collections;
	},
	readiness: async (target, { signal } = {}) => {
		const response = await (target === "global" ? global : tenant).send("/health/ready", { method: "GET", signal });
		if (response.status === 503) {
			const body: unknown = await response
				.clone()
				.json()
				.catch(() => undefined);
			if (isReadiness(body)) return body;
		}
		const body = await readResponse<unknown>(response);
		if (!isReadiness(body)) throw invalid(response, "a readiness answer");
		return body;
	},
});
