import { CliError } from "../errors.ts";
import type { EnvironmentConfig, ProjectConfig, TenantConfig } from "../project-config.ts";
import { readSecretsFile } from "../secrets-file.ts";
import { outputTail } from "../worker-target.ts";
import {
	assertOwned,
	cloudflareEnv,
	parseToolJson,
	queryD1,
	type WorkerEnvironment,
	workerEnvironment,
	workerUrl,
} from "./environment.ts";
import {
	applyRemoteMigrations,
	deployWorker,
	getUrl,
	healthy,
	pendingRemoteMigrations,
	type RemoteDeps,
	tenantSecrets,
	waitForUrl,
} from "./remote-workers.ts";

// `takebase deploy` and `takebase build`. Deploy runs in a fixed order and
// stops at the first failure: global migrations, the global Worker and its
// health, then each registered active tenant (migrations, Worker, health),
// then the app (built with the environment's settings) and its page. Every
// step is idempotent, so a rerun after a failure is safe. With `plan` it makes
// read-only calls only and reports what it would run.

export type DeployOutcome = "done" | "unchanged" | "would run" | "skipped";
export type DeployStep = { step: string; outcome: DeployOutcome; detail: string };

type Targets = {
	global: WorkerEnvironment;
	app: WorkerEnvironment;
	tenants: { tenant: TenantConfig; worker: WorkerEnvironment | undefined }[];
};

const rtdbInstance = (url: string) => /^https:\/\/([a-z0-9-]+)\.firebaseio\.com$/.exec(url)?.[1];

// Resolves every Worker of the environment and refuses, before any call, a
// name outside the environment's prefix or a tenant bound to another global Worker.
export const deploymentTargets = (project: ProjectConfig, environment: EnvironmentConfig): Targets => {
	const global = workerEnvironment(project.workers.global, environment.globalEnv);
	if (!global) throw new CliError(`The global Worker has no Wrangler environment "${environment.globalEnv}"`);
	const app = workerEnvironment(project.workers.app, environment.appEnv);
	if (!app) throw new CliError(`The app has no Wrangler environment "${environment.appEnv}"`);
	const owned = (label: string, worker: WorkerEnvironment) => {
		assertOwned(environment, `${label} Worker`, worker.workerName);
		for (const database of worker.d1) assertOwned(environment, `${label} D1 database`, database.database_name);
		for (const service of worker.services) assertOwned(environment, `${label} service binding`, service.service);
	};
	owned("global", global);
	owned("app", app);
	const tenants = environment.tenants.map((tenant) => {
		const worker = workerEnvironment(project.workers.tenant, tenant.env);
		if (worker) {
			owned(`tenant ${tenant.id}`, worker);
			const instance = rtdbInstance(worker.vars.FIREBASE_DATABASE_URL ?? "");
			if (environment.remote) {
				assertOwned(
					environment,
					`tenant ${tenant.id} Realtime Database`,
					instance ?? worker.vars.FIREBASE_DATABASE_URL ?? "",
				);
			}
			const binding = worker.services.find((service) => service.binding === "GLOBAL");
			if (binding?.service !== global.workerName) {
				throw new CliError(
					`Tenant ${tenant.id} is bound to "${binding?.service}", not the global Worker ${global.workerName}`,
				);
			}
		}
		return { tenant, worker };
	});
	return { global, app, tenants };
};

// The logged-in Cloudflare user must reach the pinned account.
export const checkAccount = (deps: RemoteDeps, project: ProjectConfig, environment: EnvironmentConfig) => {
	const env = cloudflareEnv(environment);
	const result = deps.run(project.workers.global, "wrangler", ["whoami", "--json"], env);
	const whoami = parseToolJson(result.stdout) as { loggedIn?: boolean; accounts?: { id?: string }[] } | undefined;
	if (whoami?.loggedIn !== true || !whoami.accounts?.some((account) => account.id === env.CLOUDFLARE_ACCOUNT_ID)) {
		throw new CliError("This Cloudflare login cannot use the account in CLOUDFLARE_ACCOUNT_ID", {
			hint: `Run \`wrangler login\` with the right user, or fix ${environment.secretsFile}. Nothing was changed.`,
		});
	}
};

// The app's settings are baked in at build time.
export const appSettings = (project: ProjectConfig, environment: EnvironmentConfig): Record<string, string> => {
	if (!environment.remote) {
		return {
			VITE_TAKEBASE_GLOBAL_URL: `http://localhost:${environment.globalPort}`,
			VITE_FIREBASE_API_KEY: "demo-api-key",
			VITE_FIREBASE_PROJECT_ID: environment.firebaseProject,
		};
	}
	const global = workerEnvironment(project.workers.global, environment.globalEnv);
	const apiKey = readSecretsFile(environment.secretsFile ?? "").values.FIREBASE_API_KEY;
	if (!global || apiKey === undefined)
		throw new CliError(`FIREBASE_API_KEY is missing from ${environment.secretsFile}`);
	return {
		VITE_TAKEBASE_GLOBAL_URL: workerUrl(environment, global.workerName),
		VITE_FIREBASE_API_KEY: apiKey,
		VITE_FIREBASE_PROJECT_ID: environment.firebaseProject,
	};
};

export const buildApp = (deps: RemoteDeps, project: ProjectConfig, environment: EnvironmentConfig) => {
	const result = deps.run(project.workers.app, "vite", ["build"], appSettings(project, environment));
	if (result.status !== 0) throw new CliError(`The app build failed:\n${outputTail(result.output)}`);
};

// Bundles each Worker environment without uploading (`wrangler deploy --dry-run`),
// then builds the app with the environment's settings. Local only: no account is used.
export const buildEnvironment = (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	report: (step: DeployStep) => void,
) => {
	const targets = deploymentTargets(project, environment);
	const bundle = (label: string, dir: string, env: string | undefined) => {
		const scope = env === undefined ? [] : ["--env", env];
		const result = deps.run(dir, "wrangler", ["deploy", "--dry-run", "--outdir", "dist", ...scope]);
		if (result.status !== 0) throw new CliError(`Bundling ${label} failed:\n${outputTail(result.output)}`);
		report({ step: `${label} bundle`, outcome: "done", detail: `${env ?? "top level"} -> dist/` });
	};
	bundle("global", project.workers.global, environment.globalEnv);
	for (const { tenant, worker } of targets.tenants) {
		if (worker) bundle(`tenant ${tenant.id}`, project.workers.tenant, tenant.env);
		else report({ step: `tenant ${tenant.id} bundle`, outcome: "skipped", detail: "no Wrangler environment yet" });
	}
	buildApp(deps, project, environment);
	report({ step: "app build", outcome: "done", detail: `with ${environment.name} settings` });
};

export const deployEnvironment = async (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	{ plan = false, report = () => {} }: { plan?: boolean; report?: (step: DeployStep) => void } = {},
) => {
	if (!environment.remote) {
		throw new CliError(`Environment "${environment.name}" is local and is never deployed`, {
			hint: "Run it with `takebase dev`.",
		});
	}
	const targets = deploymentTargets(project, environment);
	checkAccount(deps, project, environment);
	appSettings(project, environment);

	const steps: DeployStep[] = [];
	const emit = (step: DeployStep) => {
		steps.push(step);
		report(step);
	};
	const migrations = (label: string, dir: string, env: string | undefined) => {
		const pending = pendingRemoteMigrations(deps, dir, env, environment);
		if (pending.length === 0)
			return emit({ step: `${label} migrations`, outcome: "unchanged", detail: "none pending" });
		if (!plan) applyRemoteMigrations(deps, dir, env, environment);
		emit({ step: `${label} migrations`, outcome: plan ? "would run" : "done", detail: pending.join(", ") });
	};
	const worker = async (
		label: string,
		dir: string,
		env: string | undefined,
		url: string,
		accept: ReturnType<typeof healthy>,
		secrets?: Record<string, string>,
	) => {
		if (plan) {
			const now = await getUrl(deps, url);
			emit({ step: `${label} deploy`, outcome: "would run", detail: `wrangler deploy --env ${env}` });
			emit({ step: `${label} check`, outcome: "would run", detail: `${url} answers ${now.status} now` });
			return;
		}
		deployWorker(deps, dir, env, environment, secrets);
		emit({ step: `${label} deploy`, outcome: "done", detail: env ?? "top level" });
		const answer = await waitForUrl(deps, url, accept);
		emit({ step: `${label} check`, outcome: "done", detail: `${url} ${answer.status} (attempt ${answer.attempt})` });
	};

	migrations("global", project.workers.global, environment.globalEnv);
	const globalUrl = workerUrl(environment, targets.global.workerName);
	await worker("global", project.workers.global, environment.globalEnv, `${globalUrl}/health`, healthy({}));

	const rows = queryD1(
		project.workers.global,
		environment.globalEnv,
		environment,
		"select id, status, url from tenants order by id",
		deps.run,
	);
	const registered = new Map(rows.map((row) => [String(row.id), row]));
	for (const { tenant, worker: tenantWorker } of targets.tenants) {
		const label = `tenant ${tenant.id}`;
		const row = registered.get(tenant.id);
		if (!tenantWorker || !row) {
			emit({
				step: label,
				outcome: "skipped",
				detail: `not provisioned; run \`takebase tenant provision ${tenant.id} --env ${environment.name}\``,
			});
			continue;
		}
		if (row.status !== "active") {
			emit({ step: label, outcome: "skipped", detail: String(row.status) });
			continue;
		}
		const url = workerUrl(environment, tenantWorker.workerName);
		if (row.url !== url) throw new CliError(`Tenant ${tenant.id} is registered with ${String(row.url)}, not ${url}`);
		migrations(label, project.workers.tenant, tenant.env);
		await worker(
			label,
			project.workers.tenant,
			tenant.env,
			`${url}/health`,
			healthy({ tenantId: tenant.id }),
			tenantSecrets(environment, tenant.id),
		);
	}

	const appUrl = workerUrl(environment, targets.app.workerName);
	if (plan) {
		emit({ step: "app build", outcome: "would run", detail: `vite build with ${environment.name} settings` });
	} else {
		buildApp(deps, project, environment);
		emit({ step: "app build", outcome: "done", detail: `with ${environment.name} settings` });
	}
	await worker(
		"app",
		project.workers.app,
		environment.appEnv,
		appUrl,
		(answer) => answer.status === 200 && answer.body.includes("__sveltekit"),
	);
	return steps;
};
