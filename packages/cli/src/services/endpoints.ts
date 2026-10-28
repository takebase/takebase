import { CliError } from "../errors.ts";
import type { EnvironmentConfig, ProjectConfig } from "../project-config.ts";
import { pagesUrl, workerEnvironment, workerUrl } from "./environment.ts";

// Where an environment's Workers answer: `takebase dev`'s localhost ports
// locally, each Worker's workers.dev URL remotely.

export type Endpoint = { label: string; url: string };

const remoteUrl = (environment: EnvironmentConfig, dir: string, env: string | undefined, label: string) => {
	const worker = workerEnvironment(dir, env);
	if (!worker) throw new CliError(`No Wrangler environment for ${label}`, { hint: "Run `takebase doctor`." });
	return workerUrl(environment, worker.workerName);
};

export const globalEndpoint = (project: ProjectConfig, environment: EnvironmentConfig): Endpoint => ({
	label: "global",
	url: environment.remote
		? remoteUrl(environment, project.workers.global, environment.globalEnv, "the global Worker")
		: `http://localhost:${environment.globalPort}`,
});

export const appEndpoint = (project: ProjectConfig, environment: EnvironmentConfig): Endpoint => ({
	label: "app",
	url: environment.remote
		? remoteUrl(environment, project.workers.app, environment.appEnv, "the app Worker")
		: `http://localhost:${environment.appPort}`,
});

// The static admin app, when the project has one: `takebase dev`'s port
// locally, its Cloudflare Pages project remotely.
export const adminEndpoint = (project: ProjectConfig, environment: EnvironmentConfig): Endpoint | undefined => {
	if (project.workers.admin === undefined) return undefined;
	return {
		label: "admin",
		url: environment.remote ? pagesUrl(environment.adminProject ?? "") : `http://localhost:${environment.adminPort}`,
	};
};

export const tenantEndpoint = (project: ProjectConfig, environment: EnvironmentConfig, id: string): Endpoint => {
	const tenant = environment.tenants.find((candidate) => candidate.id === id);
	if (!tenant) {
		throw new CliError(`Tenant "${id}" is not declared for environment "${environment.name}"`, {
			hint: `Declared: ${environment.tenants.map((candidate) => candidate.id).join(", ") || "none"}.`,
		});
	}
	return {
		label: `tenant ${id}`,
		url: environment.remote
			? remoteUrl(environment, project.workers.tenant, tenant.env, `tenant ${id}`)
			: `http://localhost:${tenant.port}`,
	};
};
