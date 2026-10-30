import type { TenantSecretsReport } from "@takebase/contracts";
import { readResponse, TakebaseError } from "./errors.ts";
import type { Http, RequestOptions } from "./http.ts";

// The selected tenant's secret status, for that tenant's admins (the tenant
// Worker decides): key state and metadata, never a value or a key. Nothing
// here changes keys; rotation is the operator's `takebase secrets rotate`.
export type TenantSecretsClient = {
	secrets: (options?: RequestOptions) => Promise<TenantSecretsReport>;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isVersion = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const states = ["ok", "unconfigured", "missing_key", "mismatch"];

const isReport = (value: unknown): value is TenantSecretsReport =>
	isObject(value) &&
	typeof value.tenantId === "string" &&
	(value.environment === null || typeof value.environment === "string") &&
	states.includes(value.state as string) &&
	(value.activeKeyVersion === null || isVersion(value.activeKeyVersion)) &&
	Array.isArray(value.installedKeyVersions) &&
	value.installedKeyVersions.every(isVersion) &&
	Array.isArray(value.secrets) &&
	value.secrets.every(
		(secret) =>
			isObject(secret) &&
			Object.keys(secret).length === 4 &&
			typeof secret.purpose === "string" &&
			typeof secret.name === "string" &&
			isVersion(secret.keyVersion) &&
			typeof secret.updated === "string",
	);

export const createSecretsClient = (tenant: Http): TenantSecretsClient => ({
	secrets: async ({ signal } = {}) => {
		const response = await tenant.send("/api/admin/secrets", { method: "GET", signal });
		const body = await readResponse<unknown>(response);
		if (!isReport(body)) {
			throw new TakebaseError(response.status, "invalid_response", "Response is not a secrets report");
		}
		return body;
	},
});
