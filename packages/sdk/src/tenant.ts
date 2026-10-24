import { isTenantListResponse, type TenantMembership } from "@takebase/contracts";
import { readResponse, TakebaseError } from "./errors.ts";
import type { Http, RequestOptions } from "./http.ts";

// Tenant discovery from the global Worker: the active tenants the signed-in
// user belongs to, with roles. Roles are for display; tenant Workers enforce them.
export const fetchTenants = async (global: Http, { signal }: RequestOptions = {}): Promise<TenantMembership[]> => {
	const response = await global.send("/api/tenants", { method: "GET", signal });
	const body = await readResponse<unknown>(response);
	if (!isTenantListResponse(body)) {
		throw new TakebaseError(response.status, "invalid_response", "Response is not a tenant list");
	}
	return body.tenants;
};
