import { relative } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { CliError, type CliIo } from "../errors.ts";
import {
	dispatcherPasswordKey,
	type EnvironmentConfig,
	loadProjectConfig,
	type ProjectConfig,
	resolveEnvironment,
} from "../project-config.ts";
import { readSecretsFile } from "../secrets-file.ts";
import {
	cloudflareEnv,
	queryD1,
	remotePendingMigrations,
	type WorkerEnvironment,
	workerEnvironment,
	workerUrl,
} from "../services/environment.ts";
import { readHistory } from "../services/migration-service.ts";
import { resolveTarget, runFirebase, runTool } from "../worker-target.ts";

// Read-only checks of one environment: tools, takebase.jsonc against each
// Worker's wrangler.jsonc, secrets (presence only), identity, resources and
// database state. Never writes anything, locally or remotely.

const usage = "takebase doctor [--env <name>]";

const help = `Validate the tools, configuration, identity and databases of one environment.

Usage: ${usage}

Options:
  --env <name>  Environment from takebase.jsonc (default: local)
  -h, --help    Show this help

Every check is read-only. A remote environment reads its Cloudflare account and
Firebase project, but never changes them. Secret values are never printed.
`;

const options = { env: { type: "string" }, help: { type: "boolean", short: "h" } } as const;

type Status = "ok" | "warn" | "fail";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const secretVars = ["FIREBASE_API_KEY", "FIREBASE_DISPATCHER_EMAIL", "FIREBASE_DISPATCHER_PASSWORD"];

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

const createReport = (io: CliIo) => {
	const counts: Record<Status, number> = { ok: 0, warn: 0, fail: 0 };
	const report = (status: Status, label: string, detail = "") => {
		counts[status]++;
		const tag = status === "ok" ? "ok  " : status === "warn" ? "warn" : "FAIL";
		io.stdout(`${tag} ${label}${detail === "" ? "" : `: ${detail}`}\n`);
	};
	const expect = (ok: boolean, label: string, detail = "") => report(ok ? "ok" : "fail", label, detail);
	// Runs a check that may throw (a tool error) and reports the throw as a failure.
	const guard = (label: string, check: () => void) => {
		try {
			check();
		} catch (error) {
			report("fail", label, error instanceof Error ? error.message.split("\n")[0] : String(error));
		}
	};
	const section = (title: string) => io.stdout(`-- ${title}\n`);
	return { report, expect, guard, section, counts };
};

type Report = ReturnType<typeof createReport>;

const toolVersion = (output: string) => /\d+\.\d+\.\d+/.exec(output)?.[0] ?? output.trim();

const checkTools = (io: CliIo, report: Report, project: ProjectConfig) => {
	report.section("tools");
	const major = Number(process.versions.node.split(".")[0]);
	report.expect(major >= 24, "node", `${process.version}${major >= 24 ? "" : " (needs 24 or later)"}`);
	const versions = new Set<string>();
	for (const [name, dir] of Object.entries(project.workers)) {
		report.guard(`wrangler (${name})`, () => {
			const result = runTool(dir, "wrangler", ["--version"]);
			const version = toolVersion(result.stdout);
			versions.add(version);
			report.expect(result.status === 0, `wrangler (${name})`, `${version} in ${relative(io.cwd, dir) || "."}`);
		});
	}
	if (versions.size > 1) report.report("warn", "wrangler versions differ", [...versions].join(", "));
	report.guard("firebase", () => {
		const result = runFirebase(project.root, ["--version"]);
		report.expect(result.status === 0, "firebase", toolVersion(result.stdout));
	});
};

// The checks shared by the global, tenant and app Workers of a remote environment.
const checkRemoteNames = (report: Report, environment: EnvironmentConfig, label: string, worker: WorkerEnvironment) => {
	const prefix = environment.namePrefix ?? "";
	report.expect(worker.workerName.startsWith(prefix), `${label} Worker name`, worker.workerName);
	for (const database of worker.d1) {
		report.expect(
			database.database_name.startsWith(prefix) && uuidPattern.test(database.database_id),
			`${label} D1 ${database.binding}`,
			`${database.database_name} ${shortId(database.database_id)}`,
		);
	}
	const leaked = secretVars.filter((name) => name in worker.vars);
	report.expect(leaked.length === 0, `${label} keeps secrets out of vars`, leaked.join(", ") || "none in vars");
};

const checkLocalDatabases = (report: Report, label: string, worker: WorkerEnvironment) => {
	for (const database of worker.d1) {
		report.expect(
			database.database_id.startsWith("local-"),
			`${label} D1 ${database.binding}`,
			`${database.database_name} (local only)`,
		);
	}
};

const checkConfiguration = (report: Report, project: ProjectConfig, environment: EnvironmentConfig) => {
	report.section(`configuration (${relative(project.root, project.file)})`);
	const env = environment.globalEnv;
	const global = workerEnvironment(project.workers.global, env);
	const describe = (name: string | undefined) => (name === undefined ? "top level" : `env "${name}"`);
	report.expect(global !== undefined, "global Worker environment", describe(env));
	if (global) {
		report.expect(
			global.vars.FIREBASE_PROJECT_ID === environment.firebaseProject,
			"global FIREBASE_PROJECT_ID",
			global.vars.FIREBASE_PROJECT_ID ?? "missing",
		);
		report.expect(global.d1.length === 1 && global.d1[0]?.binding === "DB", "global D1 binding DB");
		if (environment.remote) checkRemoteNames(report, environment, "global", global);
		else checkLocalDatabases(report, "global", global);
	}

	const app = workerEnvironment(project.workers.app, environment.appEnv);
	report.expect(app !== undefined, "app Worker environment", describe(environment.appEnv));
	if (app && environment.remote) {
		report.expect(app.workerName.startsWith(environment.namePrefix ?? ""), "app Worker name", app.workerName);
	}

	const seen = new Map<string, string>();
	for (const tenant of environment.tenants) {
		const label = `tenant ${tenant.id}`;
		const worker = workerEnvironment(project.workers.tenant, tenant.env);
		report.expect(worker !== undefined, `${label} Worker environment`, describe(tenant.env));
		if (!worker) continue;
		report.expect(worker.vars.TENANT_ID === tenant.id, `${label} TENANT_ID`, worker.vars.TENANT_ID ?? "missing");
		const binding = worker.services.find((service) => service.binding === "GLOBAL");
		report.expect(
			binding?.service === global?.workerName && binding?.entrypoint === "MembershipEntrypoint",
			`${label} GLOBAL binding`,
			binding ? `${binding.service}#${binding.entrypoint}` : "missing",
		);
		const database = worker.d1.length === 1 ? worker.d1[0] : undefined;
		report.expect(database?.binding === "DB", `${label} D1 binding DB`);
		if (database) {
			const owner = seen.get(database.database_id);
			report.expect(owner === undefined, `${label} has its own D1 database`, owner ? `shared with ${owner}` : "");
			seen.set(database.database_id, tenant.id);
		}
		const url = worker.vars.FIREBASE_DATABASE_URL ?? "";
		if (environment.remote) {
			checkRemoteNames(report, environment, label, worker);
			const instance = /^https:\/\/([a-z0-9-]+)\.firebaseio\.com$/.exec(url)?.[1];
			report.expect(
				instance?.startsWith(environment.namePrefix ?? "") === true,
				`${label} Realtime Database`,
				url || "missing",
			);
			if (app) {
				const origin = workerUrl(environment, app.workerName);
				report.expect(
					(worker.vars.CORS_ORIGINS ?? "").split(",").includes(origin),
					`${label} CORS_ORIGINS allows the app`,
					worker.vars.CORS_ORIGINS ?? "missing",
				);
			}
		} else {
			checkLocalDatabases(report, label, worker);
			report.expect(
				/^http:\/\/(127\.0\.0\.1|localhost):/.test(url),
				`${label} Realtime Database emulator`,
				url || "missing",
			);
		}
	}
};

const checkSecrets = (report: Report, project: ProjectConfig, environment: EnvironmentConfig) => {
	if (environment.secretsFile === undefined) return;
	const secrets = readSecretsFile(environment.secretsFile);
	report.section(`secrets (${relative(project.root, secrets.path)}; values are never shown)`);
	report.expect(secrets.exists, "secrets file exists");
	if (!secrets.exists) return;
	report.expect(secrets.mode === 0o600, "secrets file mode", `${secrets.mode?.toString(8)} (expected 600)`);
	const keys = [
		"FIREBASE_API_KEY",
		"CLOUDFLARE_ACCOUNT_ID",
		...environment.tenants.map((tenant) => dispatcherPasswordKey(environment, tenant.id) ?? ""),
	];
	for (const key of keys) report.expect(key in secrets.values, key, key in secrets.values ? "present" : "missing");
};

const parseJson = (stdout: string): unknown => {
	const start = stdout.search(/[[{]/);
	return start === -1 ? undefined : JSON.parse(stdout.slice(start));
};

const checkIdentity = (report: Report, project: ProjectConfig, environment: EnvironmentConfig) => {
	report.section("identity (read-only)");
	report.guard("Cloudflare account", () => {
		const env = cloudflareEnv(environment);
		const result = runTool(project.workers.global, "wrangler", ["whoami", "--json"], env);
		const whoami = parseJson(result.stdout) as { loggedIn?: boolean; accounts?: { id?: string }[] } | undefined;
		const ok =
			whoami?.loggedIn === true && whoami.accounts?.some((account) => account.id === env.CLOUDFLARE_ACCOUNT_ID);
		report.expect(
			ok === true,
			"Cloudflare account",
			ok
				? `${shortId(env.CLOUDFLARE_ACCOUNT_ID ?? "")} reachable with this login`
				: "this login cannot use CLOUDFLARE_ACCOUNT_ID",
		);
	});
	report.guard("Firebase project", () => {
		const result = runFirebase(project.root, ["projects:list", "--json"]);
		const listed = (parseJson(result.stdout) as { result?: { projectId?: string }[] } | undefined)?.result ?? [];
		report.expect(
			listed.some((entry) => entry.projectId === environment.firebaseProject),
			"Firebase project",
			`${environment.firebaseProject}${result.status === 0 ? "" : " (firebase projects:list failed)"}`,
		);
	});
};

const checkResources = (report: Report, project: ProjectConfig, environment: EnvironmentConfig) => {
	report.section("resources (read-only)");
	const configured = [
		workerEnvironment(project.workers.global, environment.globalEnv),
		...environment.tenants.map((tenant) => workerEnvironment(project.workers.tenant, tenant.env)),
	].flatMap((worker) => worker?.d1 ?? []);
	report.guard("D1 databases", () => {
		const result = runTool(project.workers.global, "wrangler", ["d1", "list", "--json"], cloudflareEnv(environment));
		const existing = (parseJson(result.stdout) as { name?: string; uuid?: string }[] | undefined) ?? [];
		for (const database of configured) {
			const found = existing.find((entry) => entry.name === database.database_name);
			report.expect(
				found?.uuid === database.database_id,
				`D1 ${database.database_name}`,
				found
					? found.uuid === database.database_id
						? "exists"
						: `exists with another id ${shortId(found.uuid ?? "")}`
					: "missing",
			);
		}
	});
	report.guard("Realtime Databases", () => {
		const result = runFirebase(project.root, [
			"database:instances:list",
			"--project",
			environment.firebaseProject,
			"--json",
		]);
		const instances =
			(parseJson(result.stdout) as { result?: { name?: string; state?: string }[] } | undefined)?.result ?? [];
		for (const tenant of environment.tenants) {
			const url = workerEnvironment(project.workers.tenant, tenant.env)?.vars.FIREBASE_DATABASE_URL ?? "";
			const name = /^https:\/\/([a-z0-9-]+)\.firebaseio\.com$/.exec(url)?.[1] ?? "";
			const found = instances.find((instance) => instance.name === name);
			report.expect(found?.state === "ACTIVE", `Realtime Database ${name || tenant.id}`, found?.state ?? "missing");
		}
	});
};

const checkDatabases = (io: CliIo, report: Report, project: ProjectConfig, environment: EnvironmentConfig) => {
	report.section(`databases (${environment.remote ? "remote, read-only" : "local"})`);
	report.guard("global migrations", () => {
		if (environment.remote) {
			const pending = remotePendingMigrations(project.workers.global, environment.globalEnv, environment);
			report.expect(pending === "none", "global migrations", pending === "none" ? "none pending" : pending);
			return;
		}
		const history = readHistory(resolveTarget(io.cwd, { worker: project.workers.global, env: environment.globalEnv }));
		report.expect(
			history.pending.length === 0 && history.problems.length === 0,
			"global migrations",
			history.problems[0] ?? `${history.applied.length} applied, ${history.pending.length} pending`,
		);
	});
	if (environment.remote) {
		for (const tenant of environment.tenants) {
			report.guard(`tenant ${tenant.id} migrations`, () => {
				const pending = remotePendingMigrations(project.workers.tenant, tenant.env, environment);
				report.expect(
					pending === "none",
					`tenant ${tenant.id} migrations`,
					pending === "none" ? "none pending" : pending,
				);
			});
		}
	} else {
		report.report("ok", "tenant migrations", "not checked locally: `pnpm dev:stack` recreates tenant databases");
	}
	report.guard("tenant registrations", () => {
		const rows = queryD1(
			project.workers.global,
			environment.globalEnv,
			environment,
			"select id, status from tenants order by id",
		);
		const registered = new Map(rows.map((row) => [String(row.id), String(row.status)]));
		for (const tenant of environment.tenants) {
			const status = registered.get(tenant.id);
			if (status === "active") report.report("ok", `tenant ${tenant.id} registered`, "active");
			else if (status === undefined)
				report.report("warn", `tenant ${tenant.id} registered`, "no (not provisioned yet)");
			else report.report("warn", `tenant ${tenant.id} registered`, status);
		}
		for (const id of registered.keys()) {
			if (!environment.tenants.some((tenant) => tenant.id === id)) {
				report.report("fail", `tenant ${id} registered`, "but not declared in takebase.jsonc");
			}
		}
	});
};

export const doctorCommand = (args: string[], io: CliIo) => {
	const { values, positionals } = parseCommandArgs("doctor", args, options);
	if (values.help === true) {
		io.stdout(help);
		return 0;
	}
	if (positionals.length > 0) {
		throw new CliError(`Unexpected arguments: ${positionals.join(" ")}`, { usage: true, hint: `Usage: ${usage}` });
	}
	const project = loadProjectConfig(io.cwd);
	const environment = resolveEnvironment(project, values.env);
	const report = createReport(io);
	io.stdout(`Doctor for environment "${environment.name}" (${environment.remote ? "remote" : "local"})\n`);
	checkTools(io, report, project);
	checkConfiguration(report, project, environment);
	checkSecrets(report, project, environment);
	if (environment.remote) {
		checkIdentity(report, project, environment);
		checkResources(report, project, environment);
	}
	checkDatabases(io, report, project, environment);
	const { ok, warn, fail } = report.counts;
	io.stdout(`\n${ok} ok, ${warn} warning(s), ${fail} failed.\n`);
	return fail === 0 ? 0 : 1;
};
