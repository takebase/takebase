import type { AdminClient, AdminInvite, AdminMember, AdminRole, CreatedInvite, TakebaseError } from "@takebase/sdk";
import { useEdge } from "#lib/edge.ts";
import { message, onReset } from "#lib/stores/session.svelte.ts";

// Members, roles and invitations of the selected tenant, through the SDK's
// admin client only. The global Worker decides every request; a refusal is
// shown as it came. Cleared on every tenant switch and sign-out.
export const access = $state({
	loaded: false,
	members: [] as AdminMember[],
	roles: [] as AdminRole[],
	invites: [] as AdminInvite[],
	// The token of the invitation just created: shown once, kept nowhere else.
	created: null as CreatedInvite | null,
	error: null as string | null,
	notice: null as string | null,
});

// Changes on every clear, so answers meant for an earlier tenant or user are dropped.
let epoch = 0;

const clear = () => {
	epoch++;
	access.loaded = false;
	access.members = [];
	access.roles = [];
	access.invites = [];
	access.created = null;
	access.error = null;
	access.notice = null;
};

onReset(clear);

// The SDK's own answer to a tenant switch or sign-out during the request.
const changed = (error: unknown) => (error as TakebaseError | null)?.code === "tenant_changed";

// Runs one admin action and applies its result, then reloads all three lists,
// with one admin client bound to the tenant selected when it started.
const act = async (action: (admin: AdminClient) => Promise<(() => void) | undefined>) => {
	const started = epoch;
	const current = () => epoch === started;
	access.error = null;
	access.notice = null;
	try {
		const admin = useEdge().client.admin();
		const apply = await action(admin);
		if (!current()) return;
		apply?.();
		const [members, roles, invites] = await Promise.all([
			admin.members.list(),
			admin.roles.list(),
			admin.invites.list(),
		]);
		if (!current()) return;
		access.members = members;
		access.roles = roles;
		access.invites = invites;
		access.loaded = true;
	} catch (error) {
		if (current() && !changed(error)) access.error = message(error);
	}
};

const run = (send: (admin: AdminClient) => Promise<unknown>) =>
	act(async (admin) => {
		await send(admin);
		return undefined;
	});

export const loadAccess = () => run(async () => {});

export const addMember = (uid: string, role: string) => run((admin) => admin.members.add(uid, role));

export const removeMember = (uid: string, role?: string) =>
	act(async (admin) => {
		const { reconciled } = await admin.members.remove(uid, role);
		return () => {
			if (!reconciled) access.notice = "Removed. Their realtime access ends on the tenant's next realtime session.";
		};
	});

export const createRole = (name: string) => run((admin) => admin.roles.create(name));

export const deleteRole = (name: string) => run((admin) => admin.roles.delete(name));

export const createInvite = (role: string, expiresInHours?: number) =>
	act(async (admin) => {
		const created = await admin.invites.create(role, expiresInHours);
		return () => {
			access.created = created;
		};
	});

export const revokeInvite = (id: string) => run((admin) => admin.invites.revoke(id));

// The admin handed the token over, or doesn't need it.
export const dismissInvite = () => {
	access.created = null;
};
