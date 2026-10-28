import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../errors.ts";
import type { EnvironmentConfig, ProjectConfig, TenantConfig } from "../project-config.ts";
import { addSecret, readSecretsFile } from "../secrets-file.ts";
import { outputTail } from "../worker-target.ts";
import { cloudflareEnv, parseToolJson, type WorkerEnvironment, workerEnvironment } from "./environment.ts";
import type { RemoteDeps } from "./remote-workers.ts";

// Tenant data keys (SEGU-223). A key is 32 random bytes, standard base64,
// generated here or read from stdin; never an argument, never printed or
// logged. It is stored first in the environment's untracked mode-600 keys
// file (the escrow copy), then installed: remotely as the Worker secret
// `DATA_KEY_V<n>` from a temporary mode-600 file, locally by `takebase dev`.
// Nothing here ever replaces a stored or installed key.

const keyPattern = /^[A-Za-z0-9+/]{43}=$/;

export const workerKeyName = (version: number) => `DATA_KEY_V${version}`;

// The keys file entry, e.g. DATA_KEY_V1_TENANT_A.
export const storedKeyName = (tenantId: string, version: number) =>
	`${workerKeyName(version)}_${tenantId.toUpperCase().replaceAll("-", "_")}`;

export const generateKey = () => randomBytes(32).toString("base64");

// Exactly one base64 key of 32 bytes (`openssl rand -base64 32`).
export const parseKeyInput = (text: string) => {
	const key = text.trim();
	if (!keyPattern.test(key) || Buffer.from(key, "base64").byteLength !== 32) {
		throw new CliError("Standard input must hold exactly one base64 key of 32 bytes", {
			hint: "For example `openssl rand -base64 32`. Nothing was changed.",
		});
	}
	return key;
};

export const keysFileOf = (environment: EnvironmentConfig) => {
	if (environment.keysFile === undefined) {
		throw new CliError(`Environment "${environment.name}" has no keysFile or secretsFile in takebase.jsonc`);
	}
	return environment.keysFile;
};

export type SecretsTarget = { tenant: TenantConfig; worker: WorkerEnvironment; version: number };

// A declared tenant whose Wrangler environment has the SECRETS binding.
export const secretsTarget = (project: ProjectConfig, environment: EnvironmentConfig, id: string): SecretsTarget => {
	const tenant = environment.tenants.find((candidate) => candidate.id === id);
	if (!tenant) {
		throw new CliError(`Tenant "${id}" is not declared for environment "${environment.name}"`, {
			hint: `Declared: ${environment.tenants.map((candidate) => candidate.id).join(", ") || "none"}.`,
		});
	}
	const worker = workerEnvironment(project.workers.tenant, tenant.env);
	const version = Number(worker?.vars.DATA_KEY_VERSION ?? "");
	const bound = worker?.kv.some((kv) => kv.binding === "SECRETS") === true;
	if (worker === undefined || !bound || !Number.isSafeInteger(version) || version < 1) {
		throw new CliError(`Tenant ${id} has no SECRETS binding and DATA_KEY_VERSION yet`, {
			hint: `Run \`takebase tenant provision ${id} --env ${environment.name}\` first. Nothing was changed.`,
		});
	}
	return { tenant, worker, version };
};

// The secret names (never values) the deployed tenant Worker has.
export const remoteSecretNames = (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	env: string,
) => {
	const result = deps.run(
		project.workers.tenant,
		"wrangler",
		["secret", "list", "--env", env, "--format", "json"],
		cloudflareEnv(environment),
	);
	const list = parseToolJson(result.stdout);
	if (result.status !== 0 || !Array.isArray(list)) {
		throw new CliError(`wrangler secret list failed:\n${outputTail(result.output)}`);
	}
	return list.map((entry) => String((entry as { name?: unknown }).name));
};

// `wrangler secret bulk` from a temporary mode-600 file, removed afterwards.
const uploadKey = (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	env: string,
	name: string,
	key: string,
) => {
	const temp = mkdtempSync(join(tmpdir(), "takebase-key-"));
	try {
		const file = join(temp, "secrets.json");
		writeFileSync(file, `${JSON.stringify({ [name]: key })}\n`, { mode: 0o600 });
		const result = deps.run(
			project.workers.tenant,
			"wrangler",
			["secret", "bulk", file, "--env", env],
			cloudflareEnv(environment),
		);
		if (result.status !== 0) throw new CliError(`wrangler secret bulk failed:\n${outputTail(result.output)}`);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
};

export type KeyInit = {
	tenantId: string;
	version: number;
	keysFile: string;
	// "generated" or "stdin" for a new key; "stored" when an escrowed key was only installed.
	source: "generated" | "stdin" | "stored";
	// The Worker it was installed on, or null locally (`takebase dev` loads it).
	installedOn: string | null;
};

export const initKey = (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	tenantId: string,
	readKey: (() => string) | undefined,
): KeyInit => {
	const { tenant, worker, version } = secretsTarget(project, environment, tenantId);
	const keysFile = keysFileOf(environment);
	const stored = storedKeyName(tenant.id, version);
	const name = workerKeyName(version);
	const inFile = readSecretsFile(keysFile).values[stored] !== undefined;
	const installed = environment.remote && remoteSecretNames(deps, project, environment, tenant.env).includes(name);
	const refuse = (why: string) =>
		new CliError(`Refusing to initialise ${name} for tenant ${tenant.id} (${environment.name}): ${why}`, {
			hint: "secrets init never replaces a key; rotation is a separate, later operation. Nothing was changed.",
		});

	if (installed && !inFile) throw refuse(`the Worker has a key but ${stored} is not in the keys file`);
	if (environment.remote ? installed : inFile) throw refuse("a key is already installed");
	if (inFile && readKey !== undefined) throw refuse(`${stored} is already stored; it would be installed as is`);

	let source: KeyInit["source"] = "stored";
	if (!inFile) {
		const key = readKey === undefined ? generateKey() : parseKeyInput(readKey());
		source = readKey === undefined ? "generated" : "stdin";
		addSecret(keysFile, stored, key);
	}
	if (!environment.remote) return { tenantId: tenant.id, version, keysFile, source, installedOn: null };
	const key = readSecretsFile(keysFile).values[stored] ?? "";
	uploadKey(deps, project, environment, tenant.env, name, key);
	return { tenantId: tenant.id, version, keysFile, source, installedOn: worker.workerName };
};

// What `takebase dev` hands one tenant Worker (`wrangler dev --env-file`):
// only that tenant's key, under its Worker secret name. Null without a key.
export const localKeyFile = (environment: EnvironmentConfig, tenantId: string, version: number, dir: string) => {
	const file = environment.keysFile;
	const key = file === undefined ? undefined : readSecretsFile(file).values[storedKeyName(tenantId, version)];
	if (key === undefined) return null;
	const path = join(dir, `${tenantId}.env`);
	writeFileSync(path, `${workerKeyName(version)}=${key}\n`, { mode: 0o600 });
	return path;
};
