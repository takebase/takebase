import type { TakebaseError, TenantBackup, TenantBackupCheck, TenantRestorePlan } from "@takebase/sdk";
import { useEdge } from "#lib/edge.ts";
import { message, onReset } from "#lib/stores/session.svelte.ts";

// The selected tenant's backups through the SDK's admin client: manifest
// metadata about this tenant and integrity checks, never backup content. The
// global Worker allows it to the tenant's admins; a refusal is shown as it
// came. Cleared on every tenant switch and sign-out.
export const backups = $state({
	list: null as TenantBackup[] | null,
	// The last check of each backup, by id.
	checks: {} as Record<string, TenantBackupCheck>,
	checking: null as string | null,
	// The restore review on screen, and the backup whose review is loading.
	plan: null as TenantRestorePlan | null,
	planning: null as string | null,
	error: null as string | null,
	loading: false,
});

// Changes on every clear, so answers meant for an earlier tenant or user are dropped.
let epoch = 0;

const clear = () => {
	epoch++;
	backups.list = null;
	backups.checks = {};
	backups.checking = null;
	backups.plan = null;
	backups.planning = null;
	backups.error = null;
	backups.loading = false;
};

onReset(clear);

const changed = (error: unknown) => (error as TakebaseError | null)?.code === "tenant_changed";

export const loadBackups = async () => {
	const started = epoch;
	backups.loading = true;
	backups.error = null;
	try {
		const list = await useEdge().client.admin().backups.list();
		if (epoch === started) backups.list = list;
	} catch (error) {
		if (epoch === started && !changed(error)) {
			backups.list = null;
			backups.error = message(error);
		}
	} finally {
		if (epoch === started) backups.loading = false;
	}
};

export const verifyBackup = async (backupId: string) => {
	const started = epoch;
	backups.checking = backupId;
	backups.error = null;
	try {
		const check = await useEdge().client.admin().backups.verify(backupId);
		if (epoch === started) backups.checks = { ...backups.checks, [backupId]: check };
	} catch (error) {
		if (epoch === started && !changed(error)) backups.error = message(error);
	} finally {
		if (epoch === started) backups.checking = null;
	}
};

// Reads the restore review. It creates nothing; the operator's CLI restores.
export const reviewRestore = async (backupId: string) => {
	const started = epoch;
	backups.planning = backupId;
	backups.plan = null;
	backups.error = null;
	try {
		const plan = await useEdge().client.admin().backups.restorePlan(backupId);
		if (epoch === started) backups.plan = plan;
	} catch (error) {
		if (epoch === started && !changed(error)) backups.error = message(error);
	} finally {
		if (epoch === started) backups.planning = null;
	}
};

// The operator command that lists what pruning would delete. Pruning covers the
// whole environment's bucket, so it is not one tenant's admin's to run.
export const pruneCommand = (environment: string) => `takebase backup prune --keep <n> --plan --env ${environment}`;
