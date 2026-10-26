import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../errors.ts";
import { dispatcherEmail, dispatcherPasswordKey, type EnvironmentConfig } from "../project-config.ts";
import { readSecretsFile } from "../secrets-file.ts";
import { outputTail, runAnyTool, type ToolRunner } from "../worker-target.ts";
import { cloudflareEnv } from "./environment.ts";

// Remote Worker operations shared by tenant provisioning and `takebase deploy`.
// Every tool call and HTTP request goes through `RemoteDeps`, so a test can
// record them; every Wrangler call is pinned to the environment's account.

export type RemoteDeps = {
	run: ToolRunner;
	fetch: typeof fetch;
	wait: (ms: number) => Promise<void>;
};

export const defaultRemoteDeps: RemoteDeps = {
	run: runAnyTool,
	fetch: (input, init) => fetch(input, init),
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const wrangler = (deps: RemoteDeps, dir: string, environment: EnvironmentConfig, args: string[], what: string) => {
	const result = deps.run(dir, "wrangler", args, cloudflareEnv(environment));
	if (result.status !== 0) throw new CliError(`${what} failed:\n${outputTail(result.output)}`);
	return result;
};

// The migration files remote D1 has not applied yet (Wrangler lists them by name).
export const pendingRemoteMigrations = (
	deps: RemoteDeps,
	dir: string,
	env: string | undefined,
	environment: EnvironmentConfig,
) => {
	const scope = env === undefined ? [] : ["--env", env];
	const result = wrangler(
		deps,
		dir,
		environment,
		["d1", "migrations", "list", "DB", "--remote", ...scope],
		"wrangler d1 migrations list",
	);
	if (result.output.includes("No migrations to apply")) return [];
	const names = [...new Set(result.output.match(/\b\d{4}_[A-Za-z0-9_-]+\.sql\b/g) ?? [])];
	if (names.length === 0) throw new CliError(`Could not read the pending migrations:\n${outputTail(result.output)}`);
	return names;
};

export const applyRemoteMigrations = (
	deps: RemoteDeps,
	dir: string,
	env: string | undefined,
	environment: EnvironmentConfig,
) => {
	const scope = env === undefined ? [] : ["--env", env];
	wrangler(
		deps,
		dir,
		environment,
		["d1", "migrations", "apply", "DB", "--remote", ...scope],
		"wrangler d1 migrations apply",
	);
};

// The secrets a tenant Worker is deployed with, read from the secrets file.
export const tenantSecrets = (environment: EnvironmentConfig, tenantId: string) => {
	const file = environment.secretsFile ?? "";
	const values = readSecretsFile(file).values;
	const passwordKey = dispatcherPasswordKey(environment, tenantId) ?? "";
	const missing = ["FIREBASE_API_KEY", passwordKey].filter((key) => values[key] === undefined);
	if (missing.length > 0) throw new CliError(`${missing.join(", ")} missing from ${file}`);
	return {
		FIREBASE_API_KEY: values.FIREBASE_API_KEY ?? "",
		FIREBASE_DISPATCHER_EMAIL: dispatcherEmail(environment, tenantId),
		FIREBASE_DISPATCHER_PASSWORD: values[passwordKey] ?? "",
	};
};

// `wrangler deploy` for one environment. Secrets go up with the version from
// a temporary mode-600 file that is removed afterwards; never on a command line.
export const deployWorker = (
	deps: RemoteDeps,
	dir: string,
	env: string | undefined,
	environment: EnvironmentConfig,
	secrets?: Record<string, string>,
) => {
	const scope = env === undefined ? [] : ["--env", env];
	if (secrets === undefined) {
		wrangler(deps, dir, environment, ["deploy", ...scope], "wrangler deploy");
		return;
	}
	const temp = mkdtempSync(join(tmpdir(), "takebase-secrets-"));
	try {
		const file = join(temp, "secrets.json");
		writeFileSync(file, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
		wrangler(deps, dir, environment, ["deploy", ...scope, "--secrets-file", file], "wrangler deploy");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
};

export type Answer = { status: number; body: string };

export const getUrl = async (deps: RemoteDeps, url: string): Promise<Answer> => {
	try {
		const response = await deps.fetch(url);
		return { status: response.status, body: await response.text() };
	} catch (error) {
		return { status: 0, body: error instanceof Error ? error.message : String(error) };
	}
};

// GETs `url` until `accept` passes. A just-deployed workers.dev name can answer
// 404 or Cloudflare error 1042 for a few seconds, so those are retried.
export const waitForUrl = async (
	deps: RemoteDeps,
	url: string,
	accept: (answer: Answer) => boolean,
	{ attempts = 6, delayMs = 2_000 }: { attempts?: number; delayMs?: number } = {},
) => {
	let answer: Answer = { status: 0, body: "" };
	for (let attempt = 1; attempt <= attempts; attempt++) {
		answer = await getUrl(deps, url);
		if (accept(answer)) return { ...answer, attempt };
		const transient =
			answer.status === 0 || answer.status === 404 || answer.status >= 500 || answer.body.includes("1042");
		if (!transient) break;
		if (attempt < attempts) await deps.wait(delayMs);
	}
	throw new CliError(`${url} did not answer as expected: ${answer.status} ${answer.body.slice(0, 200)}`);
};

export const healthy = (expected: Record<string, string>) => (answer: Answer) =>
	answer.status === 200 &&
	answer.body.includes('"database":"ok"') &&
	Object.entries(expected).every(([key, value]) => answer.body.includes(`"${key}":"${value}"`));
