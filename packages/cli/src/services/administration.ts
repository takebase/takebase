import { createHash, randomBytes } from "node:crypto";
import { CliError } from "../errors.ts";
import type { LifecycleDeps } from "./tenant-lifecycle.ts";

// Operator administration of users, members, roles and invitations, against
// global D1 with the operator's own Cloudflare login (as the tenant commands
// do). There is no HTTP superuser: this path exists only for the operator.
//
// Every change and its audit event go to D1 as one batch of statements, which
// D1 runs atomically. The invariants (declared roles, the last admin, realtime
// revocations) are enforced by the triggers in migrations/global, so a refused
// change leaves nothing behind. Changes that end someone's access then deliver
// the recorded realtime revocations through each tenant Worker's reconcile.

export type AdminDeps = LifecycleDeps;

const provider = "firebase";
const actor = "operator";

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const sqlValue = (value: string | number | null) =>
	value === null ? "null" : typeof value === "number" ? String(value) : sqlText(value);

export const uidPattern = /^[A-Za-z0-9_-]{1,128}$/;
export const roleNamePattern = /^[a-z][a-z0-9_-]{0,63}$/;

const checkUid = (uid: string) => {
	if (!uidPattern.test(uid)) throw new CliError(`"${uid}" is not a valid user id`, { usage: true });
};
const checkRole = (role: string) => {
	if (!roleNamePattern.test(role)) {
		throw new CliError(`"${role}" is not a valid role name (lowercase letters, digits, - and _)`, { usage: true });
	}
};

// The triggers' refusals, as the operator should read them.
const refusals: [RegExp, string][] = [
	[/role is not declared for this tenant/, "That role is not declared for this tenant; see `takebase role list`."],
	[/a tenant must keep at least one admin/, "The tenant would lose its last admin; assign another admin first."],
	[/the admin role is built in/, "The admin role is built in and cannot be deleted."],
	[/role is still assigned/, "The role is still assigned; unassign it from every member first."],
	[/UNIQUE constraint failed: memberships/, "The user already has that role in this tenant."],
	[/UNIQUE constraint failed: tenant_roles/, "That role is already declared."],
	[/FOREIGN KEY constraint failed/, "The tenant is not registered."],
];

const run = (deps: AdminDeps, statements: string[]) => {
	try {
		return deps.query(statements.join(";\n"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const refusal = refusals.find(([pattern]) => pattern.test(message));
		if (refusal) throw new CliError(`Refused: ${refusal[1]}`);
		throw error;
	}
};

const audit = (
	deps: AdminDeps,
	action: string,
	{
		tenant = null,
		target = null,
		detail = null,
	}: { tenant?: string | null; target?: string | null; detail?: object | null },
) =>
	`insert into audit_events (id, created, actor, action, tenant_id, target, detail) values (${[
		crypto.randomUUID(),
		deps.now().toISOString(),
		actor,
		action,
		tenant,
		target,
		detail === null ? null : JSON.stringify(detail),
	]
		.map(sqlValue)
		.join(", ")})`;

const registeredTenant = (deps: AdminDeps, tenantId: string) => {
	const [row] = deps.query(`select status, url from tenants where id = ${sqlText(tenantId)}`);
	if (!row) throw new CliError(`Tenant "${tenantId}" is not registered`, { hint: "See `takebase tenant list`." });
	return { status: String(row.status), url: String(row.url) };
};

// ---- realtime delivery ----------------------------------------------------

export type Delivery = { tenant: string; delivered: boolean; attempts: number };

const pendingIn = (deps: AdminDeps, tenantId: string) =>
	Number(
		deps.query(
			`select count(*) as n from member_revocations where tenant_id = ${sqlText(tenantId)} and confirmed is null`,
		)[0]?.n ?? 0,
	);

// Calls each owing tenant's reconcile, with backoff, until global D1 shows
// nothing pending there. A tenant Worker that cannot be reached keeps its
// revocations pending; running the command again retries.
export const deliverRevocations = async (
	deps: AdminDeps,
	subject: string | null,
	{ attempts = 5, delayMs = 500 }: { attempts?: number; delayMs?: number } = {},
): Promise<Delivery[]> => {
	const owing = deps.query(
		`select distinct r.tenant_id as tenant, t.url as url from member_revocations r join tenants t on t.id = r.tenant_id where r.confirmed is null${subject === null ? "" : ` and r.provider = ${sqlText(provider)} and r.subject = ${sqlText(subject)}`} order by r.tenant_id`,
	);
	const deliveries: Delivery[] = [];
	for (const { tenant, url } of owing) {
		const id = String(tenant);
		let delivered = false;
		let attempt = 0;
		while (!delivered && attempt < attempts) {
			attempt++;
			const status = await deps.reconcile(String(url));
			delivered = status === 200 && pendingIn(deps, id) === 0;
			if (!delivered && attempt < attempts) await deps.wait(delayMs * 2 ** (attempt - 1));
		}
		deliveries.push({ tenant: id, delivered, attempts: attempt });
	}
	return deliveries;
};

// ---- users ----------------------------------------------------------------

export type UserRow = { subject: string; status: string; revokedBefore: number | null; roles: string };

export const listUsers = (deps: AdminDeps): UserRow[] =>
	deps
		.query(
			`with subjects as (select provider, subject from identities union select provider, subject from memberships)
select s.subject as subject, coalesce(i.status, 'active') as status, i.sessions_valid_after as revoked_before,
  (select group_concat(m.tenant_id || ':' || m.role, ', ') from memberships m where m.provider = s.provider and m.subject = s.subject) as roles
from subjects s left join identities i on i.provider = s.provider and i.subject = s.subject
order by s.subject`,
		)
		.map((row) => ({
			subject: String(row.subject),
			status: String(row.status),
			revokedBefore: typeof row.revoked_before === "number" ? row.revoked_before : null,
			roles: row.roles === null || row.roles === undefined ? "" : String(row.roles),
		}));

const identityStatus = (deps: AdminDeps, uid: string) => {
	const [row] = deps.query(
		`select status from identities where provider = ${sqlText(provider)} and subject = ${sqlText(uid)}`,
	);
	return row ? String(row.status) : null;
};

// Records a user Takebase created (`user create`).
export const recordUser = (deps: AdminDeps, uid: string, email: string) => {
	checkUid(uid);
	const now = sqlText(deps.now().toISOString());
	run(deps, [
		`insert into identities (provider, subject, status, created, updated) values (${sqlText(provider)}, ${sqlText(uid)}, 'active', ${now}, ${now}) on conflict (provider, subject) do nothing`,
		audit(deps, "user.create", { target: uid, detail: { email } }),
	]);
};

export type UserChange = "disable" | "enable" | "revoke-sessions" | "delete";

// Returns false when nothing changed (already in that state).
export const changeUser = (deps: AdminDeps, uid: string, change: UserChange, confirm?: string) => {
	checkUid(uid);
	const status = identityStatus(deps, uid);
	if (status === "deleted" && change !== "delete") {
		throw new CliError(`User ${uid} was deleted; Takebase refuses them for good`);
	}
	const now = sqlText(deps.now().toISOString());
	const upsert = (set: string, values: string) =>
		`insert into identities (provider, subject, status, sessions_valid_after, created, updated) values (${sqlText(provider)}, ${sqlText(uid)}, ${values}, ${now}, ${now}) on conflict (provider, subject) do update set ${set}, updated = excluded.updated`;
	if (change === "disable") {
		if (status === "disabled") return false;
		run(deps, [upsert("status = 'disabled'", "'disabled', null"), audit(deps, "user.disable", { target: uid })]);
		return true;
	}
	if (change === "enable") {
		if (status !== "disabled") return false;
		run(deps, [
			`update identities set status = 'active', updated = ${now} where provider = ${sqlText(provider)} and subject = ${sqlText(uid)}`,
			audit(deps, "user.enable", { target: uid }),
		]);
		return true;
	}
	if (change === "revoke-sessions") {
		const seconds = Math.floor(deps.now().getTime() / 1000);
		run(deps, [
			upsert(`sessions_valid_after = ${seconds}`, `'active', ${seconds}`),
			audit(deps, "user.revoke_sessions", { target: uid }),
		]);
		return true;
	}
	if (status === "deleted") return false;
	if (confirm !== uid) {
		throw new CliError(`Deleting user ${uid} removes every membership and refuses them for good`, {
			hint: `Repeat with --confirm ${uid}. Their Firebase account is kept.`,
			usage: true,
		});
	}
	run(deps, [
		`delete from memberships where provider = ${sqlText(provider)} and subject = ${sqlText(uid)}`,
		upsert("status = 'deleted'", "'deleted', null"),
		audit(deps, "user.delete", { target: uid }),
	]);
	return true;
};

// ---- members --------------------------------------------------------------

export type MemberRow = { subject: string; roles: string; status: string };

export const listMembers = (deps: AdminDeps, tenantId: string): MemberRow[] => {
	registeredTenant(deps, tenantId);
	return deps
		.query(
			`select m.subject as subject, group_concat(m.role, ', ') as roles, coalesce(i.status, 'active') as status
from memberships m left join identities i on i.provider = m.provider and i.subject = m.subject
where m.tenant_id = ${sqlText(tenantId)} group by m.provider, m.subject order by m.subject`,
		)
		.map((row) => ({ subject: String(row.subject), roles: String(row.roles), status: String(row.status) }));
};

export const addMember = (deps: AdminDeps, tenantId: string, uid: string, role: string) => {
	checkUid(uid);
	checkRole(role);
	registeredTenant(deps, tenantId);
	const now = sqlText(deps.now().toISOString());
	run(deps, [
		`insert into memberships (id, tenant_id, provider, subject, role, created, updated) values (${sqlText(crypto.randomUUID())}, ${sqlText(tenantId)}, ${sqlText(provider)}, ${sqlText(uid)}, ${sqlText(role)}, ${now}, ${now})`,
		audit(deps, "member.add", { tenant: tenantId, target: uid, detail: { role } }),
	]);
};

// Removes one role, or every role (the membership) when `role` is undefined.
export const removeMember = (deps: AdminDeps, tenantId: string, uid: string, role?: string) => {
	checkUid(uid);
	if (role !== undefined) checkRole(role);
	registeredTenant(deps, tenantId);
	const where = `tenant_id = ${sqlText(tenantId)} and provider = ${sqlText(provider)} and subject = ${sqlText(uid)}${role === undefined ? "" : ` and role = ${sqlText(role)}`}`;
	const [found] = deps.query(`select count(*) as n from memberships where ${where}`);
	if (Number(found?.n ?? 0) === 0) {
		throw new CliError(`User ${uid} has ${role === undefined ? "no role" : `no ${role} role`} in tenant ${tenantId}`);
	}
	run(deps, [
		`delete from memberships where ${where}`,
		audit(deps, role === undefined ? "member.remove" : "member.unassign", {
			tenant: tenantId,
			target: uid,
			detail: role === undefined ? null : { role },
		}),
	]);
};

// ---- roles ----------------------------------------------------------------

export const listRoles = (deps: AdminDeps, tenantId: string) => {
	registeredTenant(deps, tenantId);
	return deps
		.query(
			`select r.name as name, (select count(*) from memberships m where m.tenant_id = r.tenant_id and m.role = r.name) as members from tenant_roles r where r.tenant_id = ${sqlText(tenantId)} order by r.name`,
		)
		.map((row) => ({ name: String(row.name), members: Number(row.members) }));
};

export const createRole = (deps: AdminDeps, tenantId: string, name: string) => {
	checkRole(name);
	registeredTenant(deps, tenantId);
	run(deps, [
		`insert into tenant_roles (tenant_id, name, created) values (${sqlText(tenantId)}, ${sqlText(name)}, ${sqlText(deps.now().toISOString())})`,
		audit(deps, "role.create", { tenant: tenantId, target: name }),
	]);
};

export const deleteRole = (deps: AdminDeps, tenantId: string, name: string) => {
	checkRole(name);
	registeredTenant(deps, tenantId);
	if (!listRoles(deps, tenantId).some((role) => role.name === name)) {
		throw new CliError(`Role ${name} is not declared in tenant ${tenantId}`);
	}
	run(deps, [
		`delete from tenant_roles where tenant_id = ${sqlText(tenantId)} and name = ${sqlText(name)}`,
		audit(deps, "role.delete", { tenant: tenantId, target: name }),
	]);
};

// ---- invitations ----------------------------------------------------------

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

const expiryPattern = /^(\d{1,4})(h|d)$/;

// Returns the token, which exists nowhere else: only its hash is stored.
export const createInvite = (deps: AdminDeps, tenantId: string, role: string, expiresIn = "72h") => {
	checkRole(role);
	const match = expiryPattern.exec(expiresIn);
	const hours = match ? Number(match[1]) * (match[2] === "d" ? 24 : 1) : 0;
	if (hours < 1 || hours > 24 * 30)
		throw new CliError("--expires must be between 1h and 30d, e.g. 72h or 7d", { usage: true });
	const tenant = registeredTenant(deps, tenantId);
	if (tenant.status !== "active") throw new CliError(`Tenant ${tenantId} is ${tenant.status}`);
	const token = randomBytes(32).toString("base64url");
	const id = crypto.randomUUID();
	const now = deps.now();
	const expires = new Date(now.getTime() + hours * 3_600_000).toISOString();
	run(deps, [
		`insert into invitations (id, tenant_id, role, token_hash, created_by, expires, created) values (${[id, tenantId, role, tokenHash(token), actor, expires, now.toISOString()].map(sqlValue).join(", ")})`,
		audit(deps, "invite.create", { tenant: tenantId, target: id, detail: { role, expires } }),
	]);
	return { id, token, expires };
};

export const listInvites = (deps: AdminDeps, tenantId: string) => {
	registeredTenant(deps, tenantId);
	const now = sqlText(deps.now().toISOString());
	return deps
		.query(
			`select id, role, expires, case when redeemed_at is not null then 'redeemed' when revoked_at is not null then 'revoked' when expires <= ${now} then 'expired' else 'pending' end as state, redeemed_by from invitations where tenant_id = ${sqlText(tenantId)} order by created`,
		)
		.map((row) => ({
			id: String(row.id),
			role: String(row.role),
			expires: String(row.expires),
			state: String(row.state),
			redeemedBy: row.redeemed_by === null || row.redeemed_by === undefined ? null : String(row.redeemed_by),
		}));
};

export const revokeInvite = (deps: AdminDeps, tenantId: string, id: string) => {
	registeredTenant(deps, tenantId);
	const pending = listInvites(deps, tenantId).find((invite) => invite.id === id);
	if (!pending) throw new CliError(`Invitation ${id} is not in tenant ${tenantId}`);
	if (pending.state !== "pending") throw new CliError(`Invitation ${id} is already ${pending.state}`);
	run(deps, [
		`update invitations set revoked_at = ${sqlText(deps.now().toISOString())} where id = ${sqlText(id)} and redeemed_at is null and revoked_at is null`,
		audit(deps, "invite.revoke", { tenant: tenantId, target: id }),
	]);
};
