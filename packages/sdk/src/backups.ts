import type { TenantBackup, TenantBackupCheck, TenantRestorePlan } from "@takebase/contracts";
import type { TenantDiagnosticsClient } from "./diagnostics.ts";
import { readResponse, TakebaseError } from "./errors.ts";
import type { Http, RequestOptions } from "./http.ts";
import type { TenantSecretsClient } from "./secret-status.ts";

// The selected tenant's backups through the global Worker, for that tenant's
// admins (the Worker decides): manifest metadata about this tenant, and an
// integrity check of its objects. Read-only: restore and prune are the
// operator's `takebase backup` commands.
export type TenantBackupsClient = {
	backups: {
		list: (options?: RequestOptions) => Promise<TenantBackup[]>;
		verify: (backupId: string, options?: RequestOptions) => Promise<TenantBackupCheck>;
		// A review of restoring this backup: the global Worker's view of the backup,
		// plus this tenant's applied migrations and installed keys. It creates nothing.
		restorePlan: (backupId: string, options?: RequestOptions) => Promise<TenantRestorePlan>;
	};
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isTexts = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);
const isCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isBackup = (value: unknown): value is TenantBackup =>
	isObject(value) &&
	isText(value.backupId) &&
	isText(value.created) &&
	["tenant", "global", "all"].includes(value.scope as string) &&
	isText(value.environment) &&
	Array.isArray(value.parts) &&
	value.parts.every(
		(part) =>
			isObject(part) && (part.kind === "d1" || part.kind === "kv") && isText(part.capturedAt) && isCount(part.bytes),
	) &&
	(value.schemaVersion === null || isText(value.schemaVersion)) &&
	isTexts(value.migrations) &&
	Array.isArray(value.keyVersions) &&
	value.keyVersions.every(isCount);

const isCheck = (value: unknown): value is TenantBackupCheck =>
	isObject(value) &&
	isText(value.backupId) &&
	(value.status === "verified" || value.status === "failed") &&
	isTexts(value.problems) &&
	isTexts(value.checked);

const isPlan = (value: unknown): value is TenantRestorePlan =>
	isObject(value) &&
	isText(value.backupId) &&
	isText(value.tenantId) &&
	isText(value.environment) &&
	isText(value.restoreId) &&
	(value.target === null ||
		(isObject(value.target) && isText(value.target.database) && isText(value.target.namespace))) &&
	(value.schemaVersion === null || isText(value.schemaVersion)) &&
	isTexts(value.migrations) &&
	isCount(value.secrets) &&
	Array.isArray(value.keyVersions) &&
	value.keyVersions.every(isCount) &&
	isCheck(value.check) &&
	isTexts(value.problems) &&
	isObject(value.commands) &&
	isText(value.commands.dryRun) &&
	isText(value.commands.restore);

// What only this tenant's Worker can say against the backup.
const tenantProblems = (
	plan: TenantRestorePlan,
	applied: string[],
	{ environment, installedKeyVersions }: { environment: string | null; installedKeyVersions: number[] },
) => {
	const problems: string[] = [];
	if (environment !== plan.environment) {
		problems.push(`this tenant runs in environment "${String(environment)}", the backup is from "${plan.environment}"`);
	}
	plan.migrations.forEach((name, i) => {
		if (applied[i] !== name) problems.push(`migration ${name} is not this tenant's migration number ${i + 1}`);
	});
	for (const version of plan.keyVersions) {
		if (!installedKeyVersions.includes(version)) {
			problems.push(`data key v${version} is not installed on this tenant's Worker; it may be in the escrow`);
		}
	}
	return problems;
};

const invalid = (response: Response, what: string) =>
	new TakebaseError(response.status, "invalid_response", `Response is not ${what}`);

// `tenantClient` reads the selected tenant's Worker for the plan's last checks.
export const createBackupsClient = (
	global: Http,
	tenantId: string,
	tenantClient: Pick<TenantDiagnosticsClient, "diagnostics"> & TenantSecretsClient,
): TenantBackupsClient => {
	const base = `/api/admin/tenants/${encodeURIComponent(tenantId)}/backups`;
	return {
		backups: {
			list: async ({ signal } = {}) => {
				const response = await global.send(base, { method: "GET", signal });
				const body = await readResponse<unknown>(response);
				const backups = isObject(body) ? body.backups : undefined;
				if (!Array.isArray(backups) || !backups.every(isBackup)) throw invalid(response, "a list of backups");
				return backups;
			},
			verify: async (backupId, { signal } = {}) => {
				const response = await global.send(`${base}/${encodeURIComponent(backupId)}/verify`, {
					method: "POST",
					signal,
				});
				const body = await readResponse<unknown>(response);
				if (!isCheck(body)) throw invalid(response, "a backup check");
				return body;
			},
			restorePlan: async (backupId, { signal } = {}) => {
				const response = await global.send(`${base}/${encodeURIComponent(backupId)}/restore-plan`, {
					method: "GET",
					signal,
				});
				const plan = await readResponse<unknown>(response);
				if (!isPlan(plan)) throw invalid(response, "a restore plan");
				const [{ migrations }, secrets] = await Promise.all([
					tenantClient.diagnostics({ signal }),
					tenantClient.secrets({ signal }),
				]);
				return { ...plan, problems: [...plan.problems, ...tenantProblems(plan, migrations, secrets)] };
			},
		},
	};
};
