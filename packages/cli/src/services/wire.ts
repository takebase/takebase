import { join } from "node:path";
import { CliError } from "../errors.ts";
import type { EnvironmentConfig, ProjectConfig } from "../project-config.ts";
import { tenantEndpoint } from "./endpoints.ts";
import { assertOwned, queryD1, workerEnvironment } from "./environment.ts";

// Notification delivery for one tenant, as the operator sees it: the tenant
// D1 outbox and global D1's pending revocations read through Wrangler (the
// operator's Cloudflare login is the authority), and delivery triggered
// through the tenant Worker's authority-free dispatch and reconcile routes.
// Output is delivery metadata only: never record ids or fields.

export type WireDeps = {
	// One SQL statement on this tenant's D1, or on global D1.
	tenant: (sql: string) => Record<string, unknown>[];
	global: (sql: string) => Record<string, unknown>[];
	// POSTs a tenant Worker route; the status (0 when unreachable) and JSON body.
	post: (path: string) => Promise<{ status: number; body: unknown }>;
	wait: (ms: number) => Promise<void>;
	now: () => Date;
};

export type WireStatus = {
	counts: { pending: number; delivered: number; dead: number };
	oldestPending: string | null;
	dead: { seq: number; id: string; collection: string; operation: string; attempts: number; created: string }[];
	revocations: { tenant: number | null; members: number };
};

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const eventIdPattern = /^[A-Za-z0-9-]{1,64}$/;
export const maxRetryEvents = 50;

export const wireStatus = (deps: WireDeps, tenantId: string): WireStatus => {
	const counts = { pending: 0, delivered: 0, dead: 0 };
	let oldestPending: string | null = null;
	for (const row of deps.tenant(
		"select status, count(*) as count, min(created) as oldest from takebase_outbox group by status",
	)) {
		const status = String(row.status) as keyof typeof counts;
		if (status in counts) counts[status] = Number(row.count);
		if (status === "pending") oldestPending = typeof row.oldest === "string" ? row.oldest : null;
	}
	const dead = deps
		.tenant(
			"select seq, id, collection, operation, attempts, created from takebase_outbox where status = 'dead' order by seq desc limit 50",
		)
		.map((row) => ({
			seq: Number(row.seq),
			id: String(row.id),
			collection: String(row.collection),
			operation: String(row.operation),
			attempts: Number(row.attempts),
			created: String(row.created),
		}));
	const [revocations] = deps.global(
		`select (select max(rev) from tenant_revocations where tenant_id = ${sqlText(tenantId)} and confirmed is null) as tenant, (select count(distinct provider || ':' || subject) from member_revocations where tenant_id = ${sqlText(tenantId)} and confirmed is null) as members`,
	);
	return {
		counts,
		oldestPending,
		dead,
		revocations: {
			tenant: typeof revocations?.tenant === "number" ? revocations.tenant : null,
			members: Number(revocations?.members ?? 0),
		},
	};
};

export type DeliveryResult = {
	attempts: number;
	dispatch: number;
	reconcile: number;
	delivered: number;
	failed: number;
	// What is still owed after the last attempt.
	status: WireStatus;
};

// Calls dispatch and reconcile until nothing selected is pending (or attempts
// run out), backing off between attempts.
const deliver = async (
	deps: WireDeps,
	tenantId: string,
	done: (status: WireStatus) => boolean,
	{ attempts, delayMs }: { attempts: number; delayMs: number },
): Promise<DeliveryResult> => {
	let delivered = 0;
	let failed = 0;
	let dispatch = 0;
	let reconcile = 0;
	let status = wireStatus(deps, tenantId);
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const dispatched = await deps.post("/api/realtime/dispatch");
		dispatch = dispatched.status;
		const counts = dispatched.body as { delivered?: unknown; failed?: unknown } | undefined;
		delivered += typeof counts?.delivered === "number" ? counts.delivered : 0;
		failed += typeof counts?.failed === "number" ? counts.failed : 0;
		reconcile = (await deps.post("/api/realtime/reconcile")).status;
		status = wireStatus(deps, tenantId);
		if (dispatch === 200 && reconcile === 200 && done(status)) {
			return { attempts: attempt, dispatch, reconcile, delivered, failed, status };
		}
		if (attempt < attempts) await deps.wait(delayMs * 2 ** (attempt - 1));
	}
	return { attempts, dispatch, reconcile, delivered, failed, status };
};

const settled = (status: WireStatus) =>
	status.counts.pending === 0 && status.revocations.tenant === null && status.revocations.members === 0;

// One delivery attempt of whatever is pending; dead events stay dead.
export const wireTest = (deps: WireDeps, tenantId: string) =>
	deliver(deps, tenantId, settled, { attempts: 1, delayMs: 0 });

// Revives dead events (by id, or all) with a fresh attempt budget, then
// delivers with retries. Returns how many were revived and the outcome.
export const wireRetry = async (
	deps: WireDeps,
	tenantId: string,
	selection: { ids: string[] } | { dead: true },
	{ attempts = 5, delayMs = 500 }: { attempts?: number; delayMs?: number } = {},
) => {
	if ("ids" in selection) {
		if (selection.ids.length === 0 || selection.ids.length > maxRetryEvents) {
			throw new CliError(`Give 1 to ${maxRetryEvents} event ids`, { usage: true });
		}
		const invalid = selection.ids.find((id) => !eventIdPattern.test(id));
		if (invalid !== undefined) throw new CliError(`Invalid event id "${invalid}"`, { usage: true });
	}
	const where =
		"ids" in selection ? `status = 'dead' and id in (${selection.ids.map(sqlText).join(", ")})` : "status = 'dead'";
	const revived = deps.tenant(
		`update takebase_outbox set status = 'pending', attempts = 0, available_at = ${sqlText(deps.now().toISOString())}, lease_token = null, lease_until = null where ${where} returning id`,
	).length;
	const result = await deliver(deps, tenantId, settled, { attempts, delayMs });
	return { revived, ...result };
};

// The real dependencies: Wrangler for both D1 databases (pinned to the
// environment's account remotely; `takebase dev`'s per-tenant state locally)
// and the tenant Worker over HTTP.
export const wireDeps = (project: ProjectConfig, environment: EnvironmentConfig, tenantId: string): WireDeps => {
	const { url } = tenantEndpoint(project, environment, tenantId);
	const tenant = environment.tenants.find(({ id }) => id === tenantId);
	const worker = tenant ? workerEnvironment(project.workers.tenant, tenant.env) : undefined;
	if (!tenant || !worker) throw new CliError(`No Wrangler environment for tenant ${tenantId}`);
	assertOwned(environment, "Worker", worker.workerName);
	for (const database of worker.d1) assertOwned(environment, "D1 database", database.database_name);
	const persistTo = join(project.workers.tenant, ".wrangler", `state-${tenantId}`);
	return {
		tenant: (sql) => queryD1(project.workers.tenant, tenant.env, environment, sql, undefined, persistTo),
		global: (sql) => queryD1(project.workers.global, environment.globalEnv, environment, sql),
		post: async (path) => {
			try {
				const response = await fetch(`${url}${path}`, { method: "POST", signal: AbortSignal.timeout(30_000) });
				let body: unknown;
				try {
					body = await response.json();
				} catch {
					body = undefined;
				}
				return { status: response.status, body };
			} catch {
				return { status: 0, body: undefined };
			}
		},
		wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		now: () => new Date(),
	};
};
