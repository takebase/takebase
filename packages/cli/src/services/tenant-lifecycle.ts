import { CliError } from "../errors.ts";

// Disabling and deleting a registered tenant, against global D1. Disable is
// one guarded UPDATE: the membership check reads status on every request, so
// API access ends with it, and the D1 triggers record the tenant-wide realtime
// revocation in that same statement. The revocation is then delivered through
// the tenant Worker's reconcile call, retried until global D1 shows it
// confirmed. Delete only ever removes the registration.

export type LifecycleDeps = {
	// Runs one SQL statement on global D1 and returns its rows.
	query: (sql: string) => Record<string, unknown>[];
	// POSTs the tenant Worker's /api/realtime/reconcile; returns the HTTP status (0 when unreachable).
	reconcile: (tenantUrl: string) => Promise<number>;
	wait: (ms: number) => Promise<void>;
	now: () => Date;
};

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

const registration = (deps: LifecycleDeps, id: string) => {
	const [row] = deps.query(
		`select status, url, (select max(rev) from tenant_revocations where tenant_id = ${sqlText(id)} and confirmed is null) as pending from tenants where id = ${sqlText(id)}`,
	);
	if (!row) {
		throw new CliError(`Tenant "${id}" is not registered`, {
			hint: "Only registered tenants can be disabled or deleted; see `takebase tenant list`.",
		});
	}
	return {
		status: String(row.status),
		url: String(row.url),
		pending: typeof row.pending === "number" ? row.pending : null,
	};
};

export type DisableResult = {
	// False when the tenant was already disabled before this call.
	changed: boolean;
	// The revocation delivered, or still pending when `delivered` is false.
	rev: number | null;
	delivered: boolean;
	attempts: number;
};

export const disableTenant = async (
	deps: LifecycleDeps,
	id: string,
	{ attempts = 5, delayMs = 500 }: { attempts?: number; delayMs?: number } = {},
): Promise<DisableResult> => {
	const before = registration(deps, id);
	const changed = before.status === "active";
	if (changed) {
		deps.query(
			`update tenants set status = 'disabled', updated = ${sqlText(deps.now().toISOString())} where id = ${sqlText(id)} and status = 'active'`,
		);
	}
	const after = registration(deps, id);
	if (after.status !== "disabled") throw new CliError(`Tenant "${id}" did not change to disabled (${after.status})`);
	if (after.pending === null) return { changed, rev: null, delivered: true, attempts: 0 };

	for (let attempt = 1; attempt <= attempts; attempt++) {
		const status = await deps.reconcile(after.url);
		if (status === 200 && registration(deps, id).pending === null) {
			return { changed, rev: after.pending, delivered: true, attempts: attempt };
		}
		if (attempt < attempts) await deps.wait(delayMs * 2 ** (attempt - 1));
	}
	return { changed, rev: after.pending, delivered: false, attempts };
};

// Removes the registration (memberships and revocations go with it by
// cascade) and nothing else: D1, the Worker and the Realtime Database stay.
export const deleteTenant = (deps: LifecycleDeps, id: string, confirm: string | undefined) => {
	const current = registration(deps, id);
	if (current.status !== "disabled") {
		throw new CliError(`Tenant "${id}" is ${current.status}; disable it first`, {
			hint: `Run \`takebase tenant disable ${id}\`, which also revokes its realtime access.`,
		});
	}
	if (current.pending !== null) {
		throw new CliError(`Tenant "${id}" still has realtime revocation ${current.pending} pending`, {
			hint: `Run \`takebase tenant disable ${id}\` again until the revocation is confirmed.`,
		});
	}
	if (confirm !== id) {
		throw new CliError(`Deleting tenant "${id}" removes its registration and memberships`, {
			hint: `Repeat with --confirm ${id} to delete it.`,
			usage: true,
		});
	}
	// Guarded again in SQL, so a tenant enabled meanwhile is never deleted.
	deps.query(
		`delete from tenants where id = ${sqlText(id)} and status = 'disabled' and not exists (select 1 from tenant_revocations where tenant_id = ${sqlText(id)} and confirmed is null)`,
	);
	if (deps.query(`select id from tenants where id = ${sqlText(id)}`).length > 0) {
		throw new CliError(`Tenant "${id}" changed while deleting; nothing was deleted`);
	}
	return current.url;
};
