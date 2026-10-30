import type { TakebaseError, TenantSecretsReport } from "@takebase/sdk";
import { useEdge } from "#lib/edge.ts";
import { message, onReset } from "#lib/stores/session.svelte.ts";

// The selected tenant's secret status through the SDK's admin client: key
// state and metadata only, never a value or key. The tenant Worker allows it
// to its admins; a refusal is shown as it came. Cleared on every tenant switch
// and sign-out.
export const secrets = $state({
	report: null as TenantSecretsReport | null,
	error: null as string | null,
	loading: false,
});

// Changes on every clear, so answers meant for an earlier tenant or user are dropped.
let epoch = 0;

const clear = () => {
	epoch++;
	secrets.report = null;
	secrets.error = null;
	secrets.loading = false;
};

onReset(clear);

export const loadSecrets = async () => {
	const started = epoch;
	secrets.loading = true;
	secrets.error = null;
	try {
		const report = await useEdge().client.admin().secrets();
		if (epoch === started) secrets.report = report;
	} catch (error) {
		if (epoch === started && (error as TakebaseError | null)?.code !== "tenant_changed") {
			secrets.report = null;
			secrets.error = message(error);
		}
	} finally {
		if (epoch === started) secrets.loading = false;
	}
};

// The operator command that rotates this tenant's key, for the review. The
// browser never rotates: the operator's CLI holds the keys file and escrow.
export const rotationCommand = (report: TenantSecretsReport) =>
	`takebase secrets rotate ${report.tenantId} --env ${report.environment ?? "local"}`;
