import type { AdminClient, Readiness, TakebaseError, TenantDiagnostics } from "@takebase/sdk";
import { useEdge } from "#lib/edge.ts";
import { message, onReset } from "#lib/stores/session.svelte.ts";

// Both Workers' readiness and the selected tenant's outbox diagnostics, through
// the SDK's admin client only. The tenant Worker allows diagnostics and retries
// to its admins; a refusal is shown as it came. Cleared on every tenant switch
// and sign-out.
export const diagnostics = $state({
	readiness: { global: null as Readiness | null, tenant: null as Readiness | null },
	tenant: null as TenantDiagnostics | null,
	// Why a part could not be read, shown next to it.
	errors: { global: null as string | null, tenant: null as string | null, diagnostics: null as string | null },
	notice: null as string | null,
	loading: false,
});

// Changes on every clear, so answers meant for an earlier tenant or user are dropped.
let epoch = 0;

const clear = () => {
	epoch++;
	diagnostics.readiness = { global: null, tenant: null };
	diagnostics.tenant = null;
	diagnostics.errors = { global: null, tenant: null, diagnostics: null };
	diagnostics.notice = null;
	diagnostics.loading = false;
};

onReset(clear);

// The SDK's own answer to a tenant switch or sign-out during the request.
const changed = (error: unknown) => (error as TakebaseError | null)?.code === "tenant_changed";

// Settles one read: its value, or the reason it failed (null when the tenant changed).
const settle = async <Value>(read: Promise<Value>) => {
	try {
		return { value: await read, error: null };
	} catch (error) {
		return { value: null, error: changed(error) ? null : message(error) };
	}
};

// Reads all three parts at once with one admin client; each one fails on its own.
const refresh = async (admin: AdminClient, started: number) => {
	const [global, tenant, report] = await Promise.all([
		settle(admin.readiness("global")),
		settle(admin.readiness("tenant")),
		settle(admin.diagnostics()),
	]);
	if (epoch !== started) return;
	diagnostics.readiness = { global: global.value, tenant: tenant.value };
	diagnostics.tenant = report.value;
	diagnostics.errors = { global: global.error, tenant: tenant.error, diagnostics: report.error };
};

export const loadDiagnostics = async () => {
	const started = epoch;
	diagnostics.loading = true;
	diagnostics.notice = null;
	try {
		await refresh(useEdge().client.admin(), started);
	} finally {
		if (epoch === started) diagnostics.loading = false;
	}
};

// Moves dead events back to pending (by id, or all of them), then reads again.
export const retryDead = async (ids?: string[]) => {
	const started = epoch;
	const admin = useEdge().client.admin();
	diagnostics.notice = null;
	diagnostics.errors.diagnostics = null;
	try {
		const { revived } = await admin.retryOutbox(ids ? { ids } : { dead: true });
		if (epoch !== started) return;
		diagnostics.notice = `${revived} dead event${revived === 1 ? "" : "s"} moved back to pending.`;
		await refresh(admin, started);
	} catch (error) {
		if (epoch === started && !changed(error)) diagnostics.errors.diagnostics = message(error);
	}
};
