import { relative } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { CliError, type CliIo } from "../errors.ts";
import {
	declareTenant,
	dispatcherEmail,
	type EnvironmentConfig,
	loadProjectConfig,
	type ProjectConfig,
	resolveEnvironment,
	type TenantConfig,
	tenantIdPattern,
} from "../project-config.ts";
import { queryD1 } from "../services/environment.ts";
import { provisionTenant, type StepResult } from "../services/provisioning.ts";
import { remoteTenantProvider } from "../services/remote-tenant-provider.ts";
import { deleteTenant, disableTenant, type LifecycleDeps } from "../services/tenant-lifecycle.ts";
import { localTenantProvider, tenantPlan } from "../services/tenant-providers.ts";

const usage = "takebase tenant <create|provision|list|disable|delete> [<id>] [options]";

const help = `Create, provision, list, disable and delete the tenants of one environment.

Usage: ${usage}

Commands:
  create <id> --name <name> [--port <port>]  Declare the tenant in takebase.jsonc, then provision it
  provision <id> [--plan]                     Create whatever the declared tenant still lacks, then register it
  list                                        Declared tenants with their registration and pending revocation
  disable <id>                                Deny all access now, then revoke all realtime access (rerun to retry)
  delete <id> --confirm <id>                  Remove a disabled tenant's registration; resources are kept

Options:
  --env <name>   Environment from takebase.jsonc (default: local)
  --name <name>  Display name (create)
  --port <port>  Local port of the tenant Worker under \`takebase dev\` (create, local only)
  --plan         Detect only: show what provision would do and change nothing
  --confirm <id> Repeat the tenant id to confirm delete
  -h, --help     Show this help

Provisioning detects each resource before creating it, so a rerun resumes after
any failure and never creates duplicates. The tenant is registered last: until
then it is invisible to discovery and membership checks. Nothing here ever
deletes a database, a Worker or a Realtime Database.
`;

const options = {
	env: { type: "string" },
	name: { type: "string" },
	port: { type: "string" },
	plan: { type: "boolean" },
	confirm: { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;

const usageError = (message: string) => new CliError(message, { usage: true, hint: `Usage: ${usage}` });

const findTenant = (environment: EnvironmentConfig, id: string) => {
	const tenant = environment.tenants.find((candidate) => candidate.id === id);
	if (!tenant) {
		throw new CliError(`Tenant "${id}" is not declared in environment "${environment.name}"`, {
			hint: "Declare and provision it with `takebase tenant create <id> --name <name>`.",
		});
	}
	return tenant;
};

const outcomeLabel: Record<StepResult["outcome"], string> = {
	exists: "exists ",
	created: "created",
	missing: "missing",
	unknown: "unknown",
	skipped: "skipped",
};

const provision = async (
	io: CliIo,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	tenant: TenantConfig,
	planOnly: boolean,
) => {
	const plan = await tenantPlan(project, environment, tenant);
	io.stdout(
		`${planOnly ? "Plan for" : "Provisioning"} tenant ${tenant.id} in "${environment.name}"${planOnly ? " (nothing will change)" : ""}\n`,
	);
	const provider = environment.remote
		? remoteTenantProvider(project, environment, tenant)
		: localTenantProvider(project, environment, tenant);
	const results = await provisionTenant(provider, plan, {
		plan: planOnly,
		report: ({ step, outcome, detail }) =>
			io.stdout(`  ${outcomeLabel[outcome]}  ${step}${detail === "" ? "" : ` (${detail})`}\n`),
	});
	if (planOnly) {
		const changes = results.filter(({ outcome }) => outcome === "missing" || outcome === "unknown").length;
		io.stdout(changes === 0 ? "Nothing to do.\n" : `${changes} step(s) would change; nothing was changed.\n`);
		return 0;
	}
	const status = results.at(-1)?.detail;
	io.stdout(
		status === "disabled"
			? `Tenant ${tenant.id} is provisioned but disabled; provision never enables a tenant.\n`
			: `Tenant ${tenant.id} is ready at ${plan.url}.\n`,
	);
	return 0;
};

const create = async (
	io: CliIo,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	id: string,
	values: { name?: string; port?: string; plan?: boolean },
) => {
	if (!tenantIdPattern.test(id)) {
		throw usageError(`"${id}" is not a valid tenant id (lowercase letters, digits and hyphens)`);
	}
	if (environment.tenants.some((tenant) => tenant.id === id)) {
		throw new CliError(`Tenant "${id}" is already declared in "${environment.name}"`, {
			hint: `Run \`takebase tenant provision ${id}\` to finish or check it.`,
		});
	}
	if (values.name === undefined) throw usageError("tenant create needs --name");
	if (environment.remote === (values.port !== undefined)) {
		throw usageError(
			environment.remote ? "--port is for local environments only" : "tenant create needs --port locally",
		);
	}
	const port = values.port === undefined ? undefined : Number(values.port);
	if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
		throw usageError("--port must be a port number from 1024 to 65535");
	}
	const taken = environment.tenants.find((tenant) => tenant.port === port && port !== undefined);
	if (taken) throw usageError(`Port ${port} is already used by tenant ${taken.id}`);
	const tenant: TenantConfig = {
		id,
		name: values.name,
		env: environment.remote ? `${environment.name}-${id}` : id,
		port,
	};
	if (values.plan === true) return provision(io, project, environment, tenant, true);
	const declared = resolveEnvironment(declareTenant(project, environment, tenant), environment.name);
	io.stdout(`Declared tenant ${id} in ${project.file}\n`);
	return provision(io, project, declared, findTenant(declared, id), false);
};

const list = (io: CliIo, project: ProjectConfig, environment: EnvironmentConfig) => {
	const rows = queryD1(
		project.workers.global,
		environment.globalEnv,
		environment,
		"select t.id, t.status, t.url, (select max(r.rev) from tenant_revocations r where r.tenant_id = t.id and r.confirmed is null) as pending from tenants t order by t.id",
	);
	const registered = new Map(rows.map((row) => [String(row.id), row]));
	const ids = [...new Set([...environment.tenants.map(({ id }) => id), ...registered.keys()])].sort();
	io.stdout(`Tenants in "${environment.name}"\n`);
	for (const id of ids) {
		const declared = environment.tenants.find((tenant) => tenant.id === id);
		const row = registered.get(id);
		const status = row ? String(row.status) : "not registered";
		const pending = row?.pending === null || row?.pending === undefined ? "" : `, revocation ${row.pending} pending`;
		const where = row ? ` ${String(row.url)}` : "";
		io.stdout(`  ${id.padEnd(20)} ${declared ? "declared" : "UNDECLARED"}  ${status}${pending}${where}\n`);
	}
	return 0;
};

const lifecycleDeps = (project: ProjectConfig, environment: EnvironmentConfig): LifecycleDeps => ({
	query: (sql) => queryD1(project.workers.global, environment.globalEnv, environment, sql),
	reconcile: async (url) => {
		try {
			const response = await fetch(`${url}/api/realtime/reconcile`, { method: "POST" });
			await response.body?.cancel();
			return response.status;
		} catch {
			return 0;
		}
	},
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => new Date(),
});

const disable = async (io: CliIo, project: ProjectConfig, environment: EnvironmentConfig, id: string) => {
	const result = await disableTenant(lifecycleDeps(project, environment), id);
	io.stdout(
		result.changed
			? `Tenant ${id} is disabled: the API refuses its members from now on.\n`
			: `Tenant ${id} was already disabled.\n`,
	);
	if (result.rev === null) {
		io.stdout("No realtime revocation is pending.\n");
		return 0;
	}
	if (result.delivered) {
		io.stdout(`Realtime revocation ${result.rev} confirmed by the tenant Worker (attempt ${result.attempts}).\n`);
		return 0;
	}
	throw new CliError(
		`Realtime revocation ${result.rev} is still pending: the tenant Worker did not confirm it after ${result.attempts} attempts`,
		{
			hint: `Members already lost API access. Make sure the tenant Worker is running, then run \`takebase tenant disable ${id}\` again.`,
		},
	);
};

const teardown = (project: ProjectConfig, environment: EnvironmentConfig, id: string) => {
	const tenant = environment.tenants.find((candidate) => candidate.id === id);
	const env = tenant?.env ?? "<env>";
	if (!environment.remote) {
		return [
			`/bin/rm -rf ${project.workers.tenant}/.wrangler/state-${id}   # its local D1`,
			`remove env "${env}" from ${project.workers.tenant}/wrangler.jsonc and "${id}" from ${project.file}`,
		];
	}
	// By name, so they still work once the Wrangler environment is gone, and
	// pinned to the environment's account (it may be shared with other projects).
	const name = `${environment.namePrefix}${id}`;
	const pinned = `CLOUDFLARE_ACCOUNT_ID=<CLOUDFLARE_ACCOUNT_ID from ${relative(project.root, environment.secretsFile ?? "")}>`;
	return [
		`(cd ${project.workers.tenant} && ${pinned} pnpm exec wrangler delete ${name})`,
		`(cd ${project.workers.tenant} && ${pinned} pnpm exec wrangler d1 delete ${name})`,
		`firebase database:instances:delete ${name} --project ${environment.firebaseProject}`,
		`delete ${dispatcherEmail(environment, id)} in the Firebase console, then remove env "${env}" and "${id}" from the config files`,
	];
};

const remove = (
	io: CliIo,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	id: string,
	confirm: string | undefined,
) => {
	deleteTenant(lifecycleDeps(project, environment), id, confirm);
	io.stdout(
		`Deleted tenant ${id}'s registration (its memberships went with it). Its resources were kept.\n` +
			"Until you remove its declaration, `takebase tenant provision` would register it again.\n" +
			`To remove the resources too, run these yourself:\n${teardown(project, environment, id)
				.map((line) => `  ${line}`)
				.join("\n")}\n`,
	);
	return 0;
};

export const tenantCommand = async (args: string[], io: CliIo) => {
	const { values, positionals } = parseCommandArgs("tenant", args, options);
	if (values.help === true) {
		io.stdout(help);
		return 0;
	}
	const [subcommand, id, ...extra] = positionals;
	if (subcommand === undefined) throw usageError("Missing tenant command");
	if (!["create", "provision", "list", "disable", "delete"].includes(subcommand)) {
		throw usageError(`Unknown tenant command "${subcommand}"`);
	}
	if (extra.length > 0) throw usageError(`Unexpected arguments: ${extra.join(" ")}`);
	const project = loadProjectConfig(io.cwd);
	const environment = resolveEnvironment(project, values.env);
	if (subcommand === "list") {
		if (id !== undefined) throw usageError("tenant list takes no tenant id");
		return list(io, project, environment);
	}
	if (id === undefined) throw usageError(`tenant ${subcommand} needs a tenant id`);
	if (subcommand === "create") return create(io, project, environment, id, values);
	if (values.name !== undefined || values.port !== undefined)
		throw usageError("--name and --port are for tenant create");
	if (values.confirm !== undefined && subcommand !== "delete") throw usageError("--confirm is for tenant delete");
	if (values.plan !== undefined && subcommand !== "provision")
		throw usageError("--plan is for tenant provision and create");
	if (subcommand === "disable") return disable(io, project, environment, id);
	if (subcommand === "delete") return remove(io, project, environment, id, values.confirm);
	return provision(io, project, environment, findTenant(environment, id), values.plan === true);
};
