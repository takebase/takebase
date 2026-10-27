import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { CliError, type CliIo } from "../errors.ts";
import { type EnvironmentConfig, loadProjectConfig, resolveEnvironment } from "../project-config.ts";
import { readSecretsFile } from "../secrets-file.ts";
import {
	type AdminDeps,
	addMember,
	changeUser,
	createInvite,
	createRole,
	type Delivery,
	deleteRole,
	deliverRevocations,
	listInvites,
	listMembers,
	listRoles,
	listUsers,
	recordUser,
	removeMember,
	revokeInvite,
	type UserChange,
} from "../services/administration.ts";
import { lifecycleDeps } from "../services/tenant-lifecycle.ts";

// `takebase user`, `takebase tenant user`, `takebase role` and `takebase
// invite`: the operator's administration of one environment's global D1.

const usageError = (usage: string, message: string) => new CliError(message, { usage: true, hint: `Usage: ${usage}` });

const context = (io: CliIo, env: string | undefined) => {
	const project = loadProjectConfig(io.cwd);
	const environment = resolveEnvironment(project, env);
	return { project, environment, deps: lifecycleDeps(project, environment) as AdminDeps };
};

const table = (io: CliIo, rows: string[][]) => {
	const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length))) ?? [];
	for (const row of rows) io.stdout(`  ${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ")}\n`);
};

// Reports realtime delivery after a change that ended someone's access.
const reportDeliveries = (io: CliIo, deliveries: Delivery[], retry: string) => {
	if (deliveries.length === 0) {
		io.stdout("No realtime revocation is pending.\n");
		return 0;
	}
	for (const { tenant, delivered, attempts } of deliveries) {
		io.stdout(
			delivered
				? `Realtime access revoked in tenant ${tenant} (attempt ${attempts}).\n`
				: `Realtime revocation in tenant ${tenant} is still pending after ${attempts} attempts.\n`,
		);
	}
	if (deliveries.every(({ delivered }) => delivered)) return 0;
	throw new CliError("Some realtime revocations are still pending", {
		hint: `The API already refuses the user. Make sure the tenant Workers are running, then run \`${retry}\` again.`,
	});
};

// ---- takebase user ----------------------------------------------------------

const userUsage = "takebase user <create|list|disable|enable|revoke-sessions|delete> [<uid>] [options]";

const userHelp = `Manage users: Takebase's record of each Firebase account.

Usage: ${userUsage}

Commands:
  create --email <email> --password-file <path>  Create the Firebase account; its generated password goes only to <path> (mode 600)
  list                                           Every known user, their status and tenant roles
  disable <uid>                                  Refuse the user everywhere and revoke their realtime access
  enable <uid>                                   Accept a disabled user again (they sign in afresh)
  revoke-sessions <uid>                          Refuse every token from a sign-in before now
  delete <uid> --confirm <uid>                   Remove every membership and refuse the user for good

Options:
  --env <name>   Environment from takebase.jsonc (default: local)
  -h, --help     Show this help

Disable, revoke-sessions and delete take effect on the next request; realtime
access is revoked through each tenant Worker (rerun to retry). The Firebase
account itself is never disabled or deleted.
`;

const identityToolkit = (environment: EnvironmentConfig) => {
	if (!environment.remote) {
		const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
		return { base: `http://${host}/identitytoolkit.googleapis.com/v1`, key: "demo-api-key" };
	}
	const key = readSecretsFile(environment.secretsFile ?? "").values.FIREBASE_API_KEY;
	if (key === undefined) throw new CliError(`FIREBASE_API_KEY is missing from ${environment.secretsFile}`);
	return { base: "https://identitytoolkit.googleapis.com/v1", key };
};

const createUser = async (io: CliIo, environment: EnvironmentConfig, deps: AdminDeps, email: string, file: string) => {
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw usageError(userUsage, `"${email}" is not an email address`);
	const path = resolve(io.cwd, file);
	const password = randomBytes(24).toString("base64url");
	// Written first, exclusively: an existing file is never overwritten.
	try {
		writeFileSync(path, `${password}\n`, { mode: 0o600, flag: "wx" });
	} catch (error) {
		throw new CliError(`Cannot create ${path}: ${error instanceof Error ? error.message : String(error)}`, {
			hint: "Pass a --password-file path that does not exist yet.",
		});
	}
	const { base, key } = identityToolkit(environment);
	let body: { localId?: string; error?: { message?: string } };
	try {
		const response = await fetch(`${base}/accounts:signUp?key=${key}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password, returnSecureToken: false }),
		});
		body = (await response.json()) as typeof body;
	} catch (error) {
		throw new CliError(
			`Firebase Auth could not be reached: ${error instanceof Error ? error.message : String(error)}`,
			{
				hint: environment.remote ? undefined : "Start the local stack with `takebase dev` first.",
			},
		);
	}
	if (!body.localId) {
		throw new CliError(`Firebase Auth did not create ${email}: ${body.error?.message ?? "unknown error"}`, {
			hint: `Delete ${path} before trying again.`,
		});
	}
	recordUser(deps, body.localId, email);
	io.stdout(`Created user ${body.localId} (${email}). Its password is only in ${path}.\n`);
	return 0;
};

export const userCommand = async (args: string[], io: CliIo) => {
	const { values, positionals } = parseCommandArgs("user", args, {
		env: { type: "string" },
		email: { type: "string" },
		"password-file": { type: "string" },
		confirm: { type: "string" },
		help: { type: "boolean", short: "h" },
	} as const);
	if (values.help === true) {
		io.stdout(userHelp);
		return 0;
	}
	const [action, uid, ...extra] = positionals;
	if (action === undefined) throw usageError(userUsage, "Missing user command");
	if (extra.length > 0) throw usageError(userUsage, `Unexpected arguments: ${extra.join(" ")}`);
	const { environment, deps } = context(io, values.env);
	if (action === "create") {
		if (uid !== undefined) throw usageError(userUsage, "user create takes no uid");
		if (values.email === undefined || values["password-file"] === undefined) {
			throw usageError(userUsage, "user create needs --email and --password-file");
		}
		return createUser(io, environment, deps, values.email, values["password-file"]);
	}
	if (action === "list") {
		const users = listUsers(deps);
		io.stdout(`Users in "${environment.name}"\n`);
		if (users.length > 0) {
			table(io, [
				["UID", "STATUS", "SESSIONS REVOKED", "ROLES"],
				...users.map((user) => [
					user.subject,
					user.status,
					user.revokedBefore === null ? "-" : new Date(user.revokedBefore * 1000).toISOString(),
					user.roles || "-",
				]),
			]);
		}
		return 0;
	}
	const changes: UserChange[] = ["disable", "enable", "revoke-sessions", "delete"];
	if (!changes.includes(action as UserChange)) throw usageError(userUsage, `Unknown user command "${action}"`);
	if (uid === undefined) throw usageError(userUsage, `user ${action} needs a uid`);
	if (values.confirm !== undefined && action !== "delete") throw usageError(userUsage, "--confirm is for user delete");
	const changed = changeUser(deps, uid, action as UserChange, values.confirm);
	const done: Record<UserChange, string> = {
		disable: "is disabled: every request is refused from now on",
		enable: "is enabled again; they sign in afresh",
		"revoke-sessions": "must sign in again: earlier sessions are refused from now on",
		delete: "is deleted: memberships removed, refused for good (the Firebase account is kept)",
	};
	io.stdout(changed ? `User ${uid} ${done[action as UserChange]}.\n` : `User ${uid} was already in that state.\n`);
	if (action === "enable") return 0;
	return reportDeliveries(io, await deliverRevocations(deps, uid), `takebase user ${action} ${uid}`);
};

// ---- takebase tenant user -----------------------------------------------------

const tenantUserUsage = "takebase tenant user <add|remove|list> <tenant> [<uid>] [--role <role>]";

export const tenantUserCommand = async (
	io: CliIo,
	env: string | undefined,
	positionals: string[],
	role: string | undefined,
) => {
	const [action, tenantId, uid, ...extra] = positionals;
	if (action === undefined || tenantId === undefined) throw usageError(tenantUserUsage, "Missing tenant user command");
	if (extra.length > 0) throw usageError(tenantUserUsage, `Unexpected arguments: ${extra.join(" ")}`);
	const { deps } = context(io, env);
	if (action === "list") {
		if (uid !== undefined || role !== undefined)
			throw usageError(tenantUserUsage, "tenant user list takes only a tenant");
		const members = listMembers(deps, tenantId);
		io.stdout(`Members of tenant ${tenantId}\n`);
		if (members.length > 0) {
			table(io, [
				["UID", "ROLES", "STATUS"],
				...members.map((member) => [member.subject, member.roles, member.status]),
			]);
		}
		return 0;
	}
	if (uid === undefined) throw usageError(tenantUserUsage, `tenant user ${action} needs a uid`);
	if (action === "add") {
		if (role === undefined) throw usageError(tenantUserUsage, "tenant user add needs --role");
		addMember(deps, tenantId, uid, role);
		io.stdout(`User ${uid} has role ${role} in tenant ${tenantId}.\n`);
		return 0;
	}
	if (action !== "remove") throw usageError(tenantUserUsage, `Unknown tenant user command "${action}"`);
	removeMember(deps, tenantId, uid, role);
	io.stdout(
		role === undefined
			? `User ${uid} is no longer a member of tenant ${tenantId}.\n`
			: `User ${uid} no longer has role ${role} in tenant ${tenantId}.\n`,
	);
	return reportDeliveries(
		io,
		await deliverRevocations(deps, uid),
		`takebase tenant user remove ${tenantId} ${uid}${role === undefined ? "" : ` --role ${role}`}`,
	);
};

// ---- takebase role ----------------------------------------------------------

const roleUsage = "takebase role <list|create|delete> <tenant> [<role>] | role <assign|unassign> <tenant> <uid> <role>";

const roleHelp = `Manage the roles a tenant declares, and who holds them.

Usage: takebase role <command> <tenant> [arguments] [--env <name>]

Commands:
  list <tenant>                     Declared roles and how many members hold each
  create <tenant> <role>            Declare a role
  delete <tenant> <role>            Remove a role no member holds (admin is built in)
  assign <tenant> <uid> <role>      Give a user a declared role (same as tenant user add)
  unassign <tenant> <uid> <role>    Take one role away (same as tenant user remove --role)

A tenant that has admins always keeps at least one: removing or demoting the last one is refused.
`;

export const roleCommand = async (args: string[], io: CliIo) => {
	const { values, positionals } = parseCommandArgs("role", args, {
		env: { type: "string" },
		help: { type: "boolean", short: "h" },
	} as const);
	if (values.help === true) {
		io.stdout(roleHelp);
		return 0;
	}
	const [action, tenantId, ...rest] = positionals;
	if (action === undefined || tenantId === undefined) throw usageError(roleUsage, "Missing role command");
	if (action === "assign" || action === "unassign") {
		const [uid, role, ...extra] = rest;
		if (uid === undefined || role === undefined || extra.length > 0) {
			throw usageError(roleUsage, `role ${action} needs <tenant> <uid> <role>`);
		}
		return tenantUserCommand(io, values.env, [action === "assign" ? "add" : "remove", tenantId, uid], role);
	}
	const { deps } = context(io, values.env);
	const [name, ...extra] = rest;
	if (extra.length > 0) throw usageError(roleUsage, `Unexpected arguments: ${extra.join(" ")}`);
	if (action === "list") {
		const roles = listRoles(deps, tenantId);
		io.stdout(`Roles of tenant ${tenantId}\n`);
		table(io, [["ROLE", "MEMBERS"], ...roles.map((role) => [role.name, String(role.members)])]);
		return 0;
	}
	if (name === undefined) throw usageError(roleUsage, `role ${action} needs a role name`);
	if (action === "create") {
		createRole(deps, tenantId, name);
		io.stdout(`Role ${name} is declared in tenant ${tenantId}.\n`);
		return 0;
	}
	if (action === "delete") {
		deleteRole(deps, tenantId, name);
		io.stdout(`Role ${name} is no longer declared in tenant ${tenantId}.\n`);
		return 0;
	}
	throw usageError(roleUsage, `Unknown role command "${action}"`);
};

// ---- takebase invite --------------------------------------------------------

const inviteUsage = "takebase invite <create|list|revoke> <tenant> [<id>] [--role <role>] [--expires <72h|7d>]";

const inviteHelp = `Manage single-use invitations to a tenant role.

Usage: ${inviteUsage}

Commands:
  create <tenant> --role <role> [--expires 72h]  Print a new invitation token (shown only once)
  list <tenant>                                  Invitations and their state
  revoke <tenant> <id>                           Cancel a pending invitation

The signed-in user redeems a token once, before it expires, and gets the role.
Only a hash of the token is stored. Nothing is emailed.
`;

export const inviteCommand = async (args: string[], io: CliIo) => {
	const { values, positionals } = parseCommandArgs("invite", args, {
		env: { type: "string" },
		role: { type: "string" },
		expires: { type: "string" },
		help: { type: "boolean", short: "h" },
	} as const);
	if (values.help === true) {
		io.stdout(inviteHelp);
		return 0;
	}
	const [action, tenantId, id, ...extra] = positionals;
	if (action === undefined || tenantId === undefined) throw usageError(inviteUsage, "Missing invite command");
	if (extra.length > 0) throw usageError(inviteUsage, `Unexpected arguments: ${extra.join(" ")}`);
	const { deps } = context(io, values.env);
	if (action === "create") {
		if (values.role === undefined) throw usageError(inviteUsage, "invite create needs --role");
		if (id !== undefined) throw usageError(inviteUsage, "invite create takes no id");
		const invite = createInvite(deps, tenantId, values.role, values.expires);
		io.stdout(
			`Invitation ${invite.id} to role ${values.role} in tenant ${tenantId}, valid until ${invite.expires}.\n` +
				`Token (shown only now; give it to the invitee):\n${invite.token}\n`,
		);
		return 0;
	}
	if (action === "list") {
		const invites = listInvites(deps, tenantId);
		io.stdout(`Invitations of tenant ${tenantId}\n`);
		if (invites.length > 0) {
			table(io, [
				["ID", "ROLE", "STATE", "EXPIRES", "REDEEMED BY"],
				...invites.map((invite) => [invite.id, invite.role, invite.state, invite.expires, invite.redeemedBy ?? "-"]),
			]);
		}
		return 0;
	}
	if (action === "revoke") {
		if (id === undefined) throw usageError(inviteUsage, "invite revoke needs an invitation id");
		revokeInvite(deps, tenantId, id);
		io.stdout(`Invitation ${id} is revoked.\n`);
		return 0;
	}
	throw usageError(inviteUsage, `Unknown invite command "${action}"`);
};
