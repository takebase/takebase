import {
	type InviteRedemption,
	isInviteRedemption,
	isTenantListResponse,
	type TenantMembership,
} from "@takebase/contracts";
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

// Redeems a tenant invitation for the signed-in user. The new role counts from
// the next request; select the tenant with useTenant() to start using it.
export const redeemInvite = async (
	global: Http,
	token: string,
	{ signal }: RequestOptions = {},
): Promise<InviteRedemption> => {
	const response = await global.send("/api/invites/redeem", { method: "POST", body: { token }, signal });
	const body = await readResponse<unknown>(response);
	if (!isInviteRedemption(body)) {
		throw new TakebaseError(response.status, "invalid_response", "Response is not an invitation redemption");
	}
	return body;
};
