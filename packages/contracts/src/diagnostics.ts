// Health and diagnostics answers. Public answers say only ok or error per
// dependency, never why: error details go to the Worker's redacted log.

// `unconfigured`: an optional dependency (realtime) has no settings, so the
// Worker serves requests without it.
export type ReadinessState = "ok" | "error" | "unconfigured";

// GET /health/ready. `error` (HTTP 503) when a required dependency fails;
// `degraded` (HTTP 200) when only an optional one is unconfigured.
export type Readiness = {
	service: string;
	status: "ok" | "degraded" | "error";
	checks: Record<string, ReadinessState>;
};

// A dead outbox event: delivery metadata only. It never carries the record id
// or any record field; the notification it stands for is a collection revision.
export type DeadOutboxEvent = {
	seq: number;
	id: string;
	collection: string;
	operation: "create" | "update" | "delete";
	attempts: number;
	created: string;
	availableAt: string;
};

// GET /api/admin/diagnostics, for an admin of this tenant only.
export type TenantDiagnostics = {
	tenantId: string;
	outbox: {
		counts: { pending: number; delivered: number; dead: number };
		// When the oldest pending event committed, or null when none waits.
		oldestPending: string | null;
		// The newest dead events, at most 50.
		dead: DeadOutboxEvent[];
	};
	// Applied tenant migrations, oldest first.
	migrations: string[];
	// Realtime revocations global D1 still owes this tenant; null when the global
	// Worker could not answer.
	revocations: { tenant: number | null; members: number } | null;
	// Whether this Worker has realtime settings.
	realtime: boolean;
};

// POST /api/admin/outbox/retry: dead events by id (at most 50), or all of them.
export type OutboxRetryRequest = { ids: string[] } | { dead: true };
export type OutboxRetryResult = { revived: number };

// POST /api/realtime/dispatch: counts only.
export type DispatchCounts = { delivered: number; failed: number; pruned: number };
