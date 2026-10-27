import type {
	AdminInvite,
	AdminMember,
	AdminRole,
	CreatedInvite,
	ErrorCode,
	FieldErrors,
	InviteRedemption,
} from "@takebase/contracts";
import type { VerifiedIdentity } from "../auth/identity-provider.ts";
import type { AnyD1Database } from "../storage/d1.ts";

// Tenant administration in global D1, for the global Worker's admin routes
// and invitation redemption. The invariants (declared roles, the last admin,
// realtime revocations) are enforced by the triggers in migrations/global;
// each change and its audit event run as one D1 batch, which is atomic, so a
// refused change leaves nothing behind.

export class AdminError extends Error {
	readonly code: ErrorCode;
	readonly fields: FieldErrors | undefined;
	constructor(code: ErrorCode, message: string, fields?: FieldErrors) {
		super(message);
		this.name = "AdminError";
		this.code = code;
		this.fields = fields;
	}
}

export const adminRoleName = "admin";
const rolePattern = /^[a-z][a-z0-9_-]{0,63}$/;
const uidPattern = /^[A-Za-z0-9_-]{1,128}$/;

// What the triggers' refusals mean to a caller.
const refusal = (error: unknown) => {
	const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
	if (/role is not declared/.test(message)) {
		return new AdminError("validation_failed", "The given data was invalid.", {
			role: "The selected role is invalid.",
		});
	}
	if (/at least one admin/.test(message)) return new AdminError("conflict", "The tenant must keep at least one admin");
	if (/admin role is built in/.test(message)) return new AdminError("conflict", "The admin role is built in");
	if (/role is still assigned/.test(message)) return new AdminError("conflict", "The role is still assigned");
	if (/UNIQUE constraint failed: memberships/.test(message)) {
		return new AdminError("conflict", "The user already has that role");
	}
	if (/UNIQUE constraint failed: tenant_roles/.test(message))
		return new AdminError("conflict", "The role already exists");
	return error;
};

const toHex = (bytes: ArrayBuffer) =>
	[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

// SHA-256 of an invitation token, as stored (the CLI computes the same).
export const inviteTokenHash = async (token: string) =>
	toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));

const newToken = () =>
	btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
		.replace(/=+$/, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");

export const actorOf = (identity: VerifiedIdentity) => `${identity.provider}:${identity.subject}`;

type Statement = ReturnType<AnyD1Database["prepare"]>;

export const createAdministrationService = (db: AnyD1Database, now: Date) => {
	const time = now.toISOString();

	const audit = (actor: string, action: string, tenantId: string, target: string, detail: object | null = null) =>
		db
			.prepare(
				"insert into audit_events (id, created, actor, action, tenant_id, target, detail) values (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(
				crypto.randomUUID(),
				time,
				actor,
				action,
				tenantId,
				target,
				detail === null ? null : JSON.stringify(detail),
			);

	const batch = async (statements: Statement[]) => {
		try {
			return await db.batch(statements);
		} catch (error) {
			throw refusal(error);
		}
	};

	const checkRole = (role: unknown): string => {
		if (typeof role !== "string" || !rolePattern.test(role)) {
			throw new AdminError("validation_failed", "The given data was invalid.", {
				role: "The role must be lowercase letters, digits, - or _.",
			});
		}
		return role;
	};
	const checkUid = (uid: unknown): string => {
		if (typeof uid !== "string" || !uidPattern.test(uid)) {
			throw new AdminError("validation_failed", "The given data was invalid.", { uid: "The uid is invalid." });
		}
		return uid;
	};

	// True when `identity` holds the built-in admin role in this active tenant.
	const isAdmin = async (identity: VerifiedIdentity, tenantId: string) =>
		(await db
			.prepare(
				"select 1 as ok from memberships m join tenants t on t.id = m.tenant_id where m.tenant_id = ? and m.provider = ? and m.subject = ? and m.role = ? and t.status = 'active'",
			)
			.bind(tenantId, identity.provider, identity.subject, adminRoleName)
			.first()) !== null;

	const tenantUrl = async (tenantId: string) =>
		(await db.prepare("select url from tenants where id = ?").bind(tenantId).first<{ url: string }>())?.url ?? null;

	const listMembers = async (tenantId: string): Promise<AdminMember[]> => {
		const { results } = await db
			.prepare(
				"select subject, group_concat(role, ',') as roles from (select subject, provider, role from memberships where tenant_id = ? order by role) group by provider, subject order by subject",
			)
			.bind(tenantId)
			.all<{ subject: string; roles: string }>();
		return results.map(({ subject, roles }: { subject: string; roles: string }) => ({
			uid: subject,
			roles: roles.split(","),
		}));
	};

	const addMember = async (actor: string, tenantId: string, uid: unknown, role: unknown) => {
		const subject = checkUid(uid);
		const name = checkRole(role);
		await batch([
			db
				.prepare(
					"insert into memberships (id, tenant_id, provider, subject, role, created, updated) values (?, ?, 'firebase', ?, ?, ?, ?)",
				)
				.bind(crypto.randomUUID(), tenantId, subject, name, time, time),
			audit(actor, "member.add", tenantId, subject, { role: name }),
		]);
	};

	// Removes one role, or the whole membership when `role` is undefined.
	const removeMember = async (actor: string, tenantId: string, uid: unknown, role?: unknown) => {
		const subject = checkUid(uid);
		const name = role === undefined ? undefined : checkRole(role);
		const where = `tenant_id = ? and provider = 'firebase' and subject = ?${name === undefined ? "" : " and role = ?"}`;
		const values = name === undefined ? [tenantId, subject] : [tenantId, subject, name];
		const found = await db
			.prepare(`select count(*) as n from memberships where ${where}`)
			.bind(...values)
			.first<{ n: number }>();
		if ((found?.n ?? 0) === 0) throw new AdminError("not_found", "The user has no such role in this tenant");
		await batch([
			db.prepare(`delete from memberships where ${where}`).bind(...values),
			audit(
				actor,
				name === undefined ? "member.remove" : "member.unassign",
				tenantId,
				subject,
				name ? { role: name } : null,
			),
		]);
	};

	const listRoles = async (tenantId: string): Promise<AdminRole[]> => {
		const { results } = await db
			.prepare(
				"select r.name as name, (select count(*) from memberships m where m.tenant_id = r.tenant_id and m.role = r.name) as members from tenant_roles r where r.tenant_id = ? order by r.name",
			)
			.bind(tenantId)
			.all<AdminRole>();
		return results;
	};

	const createRole = async (actor: string, tenantId: string, role: unknown) => {
		const name = checkRole(role);
		await batch([
			db.prepare("insert into tenant_roles (tenant_id, name, created) values (?, ?, ?)").bind(tenantId, name, time),
			audit(actor, "role.create", tenantId, name),
		]);
	};

	const deleteRole = async (actor: string, tenantId: string, role: unknown) => {
		const name = checkRole(role);
		if (!(await listRoles(tenantId)).some((declared) => declared.name === name)) {
			throw new AdminError("not_found", "No such role");
		}
		await batch([
			db.prepare("delete from tenant_roles where tenant_id = ? and name = ?").bind(tenantId, name),
			audit(actor, "role.delete", tenantId, name),
		]);
	};

	const state =
		"case when redeemed_at is not null then 'redeemed' when revoked_at is not null then 'revoked' when expires <= ?1 then 'expired' else 'pending' end";

	const listInvites = async (tenantId: string): Promise<AdminInvite[]> => {
		const { results } = await db
			.prepare(`select id, role, ${state} as state, expires from invitations where tenant_id = ?2 order by created`)
			.bind(time, tenantId)
			.all<AdminInvite>();
		return results;
	};

	const createInvite = async (
		actor: string,
		tenantId: string,
		role: unknown,
		hours: unknown = 72,
	): Promise<CreatedInvite> => {
		const name = checkRole(role);
		if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 720) {
			throw new AdminError("validation_failed", "The given data was invalid.", {
				expiresInHours: "The expiry must be a whole number of hours from 1 to 720.",
			});
		}
		const token = newToken();
		const id = crypto.randomUUID();
		const expires = new Date(now.getTime() + hours * 3_600_000).toISOString();
		await batch([
			db
				.prepare(
					"insert into invitations (id, tenant_id, role, token_hash, created_by, expires, created) values (?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(id, tenantId, name, await inviteTokenHash(token), actor, expires, time),
			audit(actor, "invite.create", tenantId, id, { role: name, expires }),
		]);
		return { id, role: name, expires, token };
	};

	const revokeInvite = async (actor: string, tenantId: string, id: string) => {
		if (!(await listInvites(tenantId)).some((invite) => invite.id === id && invite.state === "pending")) {
			throw new AdminError("not_found", "No pending invitation with that id");
		}
		await batch([
			db
				.prepare(
					"update invitations set revoked_at = ? where id = ? and tenant_id = ? and redeemed_at is null and revoked_at is null",
				)
				.bind(time, id, tenantId),
			audit(actor, "invite.revoke", tenantId, id),
		]);
	};

	// One guarded UPDATE claims the invitation (pending, unexpired, active
	// tenant); the membership and audit rows follow only from that claim, in
	// the same batch. A replayed or concurrent redemption claims nothing.
	const redeem = async (identity: VerifiedIdentity, token: unknown): Promise<InviteRedemption> => {
		const invalid = new AdminError("not_found", "The invitation is invalid, used or expired");
		if (typeof token !== "string" || token.length < 20 || token.length > 200) throw invalid;
		const hash = await inviteTokenHash(token);
		const redeemer = actorOf(identity);
		const claimed =
			"select id, tenant_id, role from invitations where token_hash = ?1 and redeemed_by = ?2 and redeemed_at = ?3";
		let claim: { meta: { changes?: number } } | undefined;
		try {
			[claim] = await batch([
				db
					.prepare(
						"update invitations set redeemed_by = ?2, redeemed_at = ?3 where token_hash = ?1 and redeemed_at is null and revoked_at is null and expires > ?3 and exists (select 1 from tenants t where t.id = invitations.tenant_id and t.status = 'active')",
					)
					.bind(hash, redeemer, time),
				db
					.prepare(
						`insert or ignore into memberships (id, tenant_id, provider, subject, role, created, updated) select ?4, tenant_id, ?5, ?6, role, ?3, ?3 from (${claimed})`,
					)
					.bind(hash, redeemer, time, crypto.randomUUID(), identity.provider, identity.subject),
				db
					.prepare(
						`insert into audit_events (id, created, actor, action, tenant_id, target, detail) select ?4, ?3, ?2, 'invite.redeem', tenant_id, id, json_object('role', role) from (${claimed})`,
					)
					.bind(hash, redeemer, time, crypto.randomUUID()),
			]);
		} catch (error) {
			// A refused membership (its role was deleted since) claims nothing either.
			if (error instanceof AdminError) throw invalid;
			throw error;
		}
		if ((claim?.meta.changes ?? 0) === 0) throw invalid;
		const row = await db
			.prepare(
				"select t.id as id, t.name as name, t.url as url, i.role as role from invitations i join tenants t on t.id = i.tenant_id where i.token_hash = ?",
			)
			.bind(hash)
			.first<{ id: string; name: string; url: string; role: string }>();
		if (!row) throw invalid;
		return { tenant: { id: row.id, name: row.name, url: row.url }, role: row.role };
	};

	return {
		isAdmin,
		tenantUrl,
		listMembers,
		addMember,
		removeMember,
		listRoles,
		createRole,
		deleteRole,
		listInvites,
		createInvite,
		revokeInvite,
		redeem,
	};
};
