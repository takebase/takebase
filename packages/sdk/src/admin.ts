import type { AdminInvite, AdminMember, AdminRole, CreatedInvite, TenantRole } from "@takebase/contracts";
import { readResponse, TakebaseError } from "./errors.ts";
import type { Http, RequestOptions } from "./http.ts";

// Tenant administration through the global Worker, for one tenant. The global
// Worker allows it only to holders of that tenant's `admin` role; nothing here
// grants or checks permissions.
export type TenantAdministration = {
	members: {
		list: (options?: RequestOptions) => Promise<AdminMember[]>;
		add: (uid: string, role: TenantRole, options?: RequestOptions) => Promise<void>;
		// Removes one role, or every role when `role` is left out. The removed
		// user's realtime access ends at once when `reconciled` is true; otherwise
		// on the tenant's next realtime session.
		remove: (uid: string, role?: TenantRole, options?: RequestOptions) => Promise<{ reconciled: boolean }>;
	};
	roles: {
		list: (options?: RequestOptions) => Promise<AdminRole[]>;
		create: (name: TenantRole, options?: RequestOptions) => Promise<void>;
		delete: (name: TenantRole, options?: RequestOptions) => Promise<void>;
	};
	invites: {
		list: (options?: RequestOptions) => Promise<AdminInvite[]>;
		// The token is in this answer only; hand it to the invitee, don't keep it.
		create: (role: TenantRole, expiresInHours?: number, options?: RequestOptions) => Promise<CreatedInvite>;
		revoke: (id: string, options?: RequestOptions) => Promise<void>;
	};
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isMember = (value: unknown): value is AdminMember =>
	isObject(value) && isText(value.uid) && Array.isArray(value.roles) && value.roles.every(isText);
const isRole = (value: unknown): value is AdminRole =>
	isObject(value) && isText(value.name) && typeof value.members === "number";
const inviteStates = ["pending", "redeemed", "revoked", "expired"];
const isInvite = (value: unknown): value is AdminInvite =>
	isObject(value) &&
	isText(value.id) &&
	isText(value.role) &&
	inviteStates.includes(value.state as string) &&
	isText(value.expires);
const isCreatedInvite = (value: unknown): value is CreatedInvite =>
	isObject(value) && isText(value.id) && isText(value.role) && isText(value.expires) && isText(value.token);

// Reads `{ [key]: Item[] }` and checks every item.
const readItems = async <Item>(response: Response, key: string, check: (value: unknown) => value is Item) => {
	const body = await readResponse<unknown>(response);
	const items = isObject(body) ? body[key] : undefined;
	if (!Array.isArray(items) || !items.every(check)) {
		throw new TakebaseError(response.status, "invalid_response", `Response is not a list of ${key}`);
	}
	return items;
};

// `global` reaches the global Worker and `tenant` the selected tenant's Worker,
// both already bound to that selection.
export const createTenantAdministration = (global: Http, tenant: Http, tenantId: string): TenantAdministration => {
	const base = `/api/admin/tenants/${encodeURIComponent(tenantId)}`;
	const path = (...parts: string[]) => [base, ...parts.map(encodeURIComponent)].join("/");
	const done = async (response: Response) => {
		await readResponse(response);
	};

	// Delivers the revocations global D1 now owes this tenant. It carries no
	// authority, and it always goes to the selected tenant, never to a URL
	// taken from an answer.
	const reconcile = async (signal: AbortSignal | undefined) => {
		try {
			await readResponse(await tenant.send("/api/realtime/reconcile", { method: "POST", signal }));
			return true;
		} catch (error) {
			if (error instanceof TakebaseError && error.code === "tenant_changed") throw error;
			return false;
		}
	};

	return {
		members: {
			list: async ({ signal } = {}) =>
				readItems(await global.send(path("members"), { method: "GET", signal }), "members", isMember),
			add: async (uid, role, { signal } = {}) =>
				done(await global.send(path("members"), { method: "POST", body: { uid, role }, signal })),
			remove: async (uid, role, { signal } = {}) => {
				const query = role === undefined ? undefined : new URLSearchParams({ role });
				await done(await global.send(path("members", uid), { method: "DELETE", query, signal }));
				return { reconciled: await reconcile(signal) };
			},
		},
		roles: {
			list: async ({ signal } = {}) =>
				readItems(await global.send(path("roles"), { method: "GET", signal }), "roles", isRole),
			create: async (name, { signal } = {}) =>
				done(await global.send(path("roles"), { method: "POST", body: { name }, signal })),
			delete: async (name, { signal } = {}) =>
				done(await global.send(path("roles", name), { method: "DELETE", signal })),
		},
		invites: {
			list: async ({ signal } = {}) =>
				readItems(await global.send(path("invites"), { method: "GET", signal }), "invites", isInvite),
			create: async (role, expiresInHours, { signal } = {}) => {
				const response = await global.send(path("invites"), {
					method: "POST",
					body: expiresInHours === undefined ? { role } : { role, expiresInHours },
					signal,
				});
				const body = await readResponse<unknown>(response);
				if (!isCreatedInvite(body))
					throw new TakebaseError(response.status, "invalid_response", "Response is not an invitation");
				return body;
			},
			revoke: async (id, { signal } = {}) => done(await global.send(path("invites", id), { method: "DELETE", signal })),
		},
	};
};
