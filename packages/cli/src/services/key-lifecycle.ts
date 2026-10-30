import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CliError } from "../errors.ts";
import { replaceJsoncProperty } from "../jsonc.ts";
import type { EnvironmentConfig, ProjectConfig, TenantConfig } from "../project-config.ts";
import { addSecret, readSecretsFile } from "../secrets-file.ts";
import { outputTail } from "../worker-target.ts";
import { tenantEndpoint } from "./endpoints.ts";
import { cloudflareEnv, parseToolJson } from "./environment.ts";
import { environmentEscrow, type Recovery, recoverKey } from "./key-escrow.ts";
import { generateKey, keysFileOf, remoteSecretNames, secretsTarget, uploadKey } from "./key-installation.ts";
import { storedKeyName, workerKeyName } from "./key-names.ts";
import {
	type EnvelopeStore,
	fullyRotated,
	type KeyRing,
	progressFile,
	type RotationProgress,
	readProgress,
	rewriteSecrets,
	verifySecrets,
	writeProgress,
} from "./key-rotation.ts";
import { deployWorker, getUrl, healthy, type RemoteDeps, tenantSecrets, waitForUrl } from "./remote-workers.ts";
import { importDataKey } from "./secret-envelopes.ts";

// `takebase secrets rotate` and `takebase secrets recover` (SEGU-224) for one
// tenant, through Wrangler: KV on the tenant's SECRETS binding (`takebase
// dev`'s state locally) and the Worker's secrets remotely.
//
// A tenant keeps one installed data key. Rotation is one command, rerun until
// it reports the old key retired; every run continues from the recorded phase:
//   1. create the new key: escrow first, then the keys file, then the Worker;
//   2. activate it: new secrets are written with it (remotely `DATA_KEY_VERSION`
//      in wrangler.jsonc and a deploy; locally `takebase dev` reads the
//      progress, so no tracked file changes);
//   3. re-encrypt every secret still on the old key (bounded by --limit);
//   4. verify, after the settle window, that every secret opens with the new key;
//   5. retire the old key: delete the Worker secret. The keys file and escrow
//      keep it as a record, never as an installed key.
// Retirement refuses while any secret cannot be opened with the new key unless
// `--accept-destructive <tenant>:v<old>` names this exact step.

// Remote KV may serve an old value for about 60 s after a write.
const remoteSettleMs = 60_000;
const maxRewritePasses = 3;

// Activation edits the tracked wrangler.jsonc: a deploy from a copy without
// the edit would point the Worker back at the old key, which is then retired.
const commitReminder = (project: ProjectConfig) =>
	`  Commit ${join(relative(project.root, project.workers.tenant), "wrangler.jsonc")} (DATA_KEY_VERSION) and run \`pnpm run cf-typegen\` there: a deploy without it would use the retired key.`;

// The rotation recorded for this tenant, or null.
export const rotationOf = (environment: EnvironmentConfig, tenantId: string) =>
	readProgress(progressFile(keysFileOf(environment), environment.name, tenantId), tenantId, environment.name);

const unfinished = (progress: RotationProgress | null) => progress !== null && progress.phase !== "retired";

// The version new secrets are written with. Remotely wrangler.jsonc says;
// locally a rotation's progress does once it is activated (see `localKeys`).
export const activeVersion = (project: ProjectConfig, environment: EnvironmentConfig, tenantId: string) => {
	const configured = secretsTarget(project, environment, tenantId).version;
	if (environment.remote) return configured;
	const progress = rotationOf(environment, tenantId);
	return progress !== null && progress.phase !== "installed" ? progress.to : configured;
};

// What `takebase dev` hands a tenant Worker: the active version, plus the old
// one while a rotation is unfinished. `override` sets DATA_KEY_VERSION when it
// differs from wrangler.jsonc (an env file overrides a config var locally).
export const localKeys = (project: ProjectConfig, environment: EnvironmentConfig, tenantId: string) => {
	const configured = secretsTarget(project, environment, tenantId).version;
	const active = activeVersion(project, environment, tenantId);
	const progress = rotationOf(environment, tenantId);
	const versions = unfinished(progress) && progress !== null ? [progress.from, progress.to] : [active];
	return { versions: [...new Set(versions)], override: active === configured ? null : active };
};

// `wrangler kv key <args>` on one tenant's SECRETS namespace; returns stdout.
// `namespace` selects another one instead (a restore target, SEGU-226).
const tenantKv =
	(
		deps: RemoteDeps,
		project: ProjectConfig,
		environment: EnvironmentConfig,
		tenant: TenantConfig,
		namespace?: string[],
	) =>
	(args: string[]) => {
		const location = environment.remote
			? ["--remote"]
			: ["--local", "--persist-to", join(project.workers.tenant, ".wrangler", `state-${tenant.id}`)];
		const result = deps.run(
			project.workers.tenant,
			"wrangler",
			["kv", "key", ...args, ...(namespace ?? ["--binding", "SECRETS", "--env", tenant.env, ...location])],
			cloudflareEnv(environment),
		);
		if (result.status !== 0) throw new CliError(`wrangler kv key ${args[0]} failed:\n${outputTail(result.output)}`);
		return result.stdout;
	};

// Every KV key under `secret/` with its metadata (never a value).
const listSecretKeys = (kv: (args: string[]) => string) => {
	const list = parseToolJson(kv(["list", "--prefix", "secret/"]));
	if (!Array.isArray(list)) throw new CliError("wrangler kv key list did not return a list");
	return list.map((entry) => ({
		name: String((entry as { name?: unknown }).name),
		metadata: (entry as { metadata?: unknown }).metadata,
	}));
};

// One tenant's SECRETS namespace as an envelope store, plus `entries` (names
// with metadata) for backups.
export const wranglerStore = (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	tenant: TenantConfig,
	namespace?: string[],
): EnvelopeStore & { entries: () => Promise<{ name: string; metadata: unknown }[]> } => {
	const kv = tenantKv(deps, project, environment, tenant, namespace);
	return {
		entries: async () => listSecretKeys(kv),
		names: async () => listSecretKeys(kv).map((entry) => entry.name),
		get: async (name) => {
			const out = kv(["get", name, "--text"]);
			const start = out.indexOf("{");
			if (out.includes("Value not found") || start === -1) return null;
			return out.slice(start, out.lastIndexOf("}") + 1);
		},
		put: async (name, value, metadata) => {
			kv(["put", name, value, "--metadata", JSON.stringify(metadata)]);
		},
	};
};

// The keys this machine holds for a tenant, from the keys file.
export const keyRing = (keysFile: string, tenantId: string): KeyRing => {
	const imported = new Map<number, ReturnType<typeof importDataKey>>();
	return (version) => {
		const cached = imported.get(version);
		if (cached) return cached;
		const key = readSecretsFile(keysFile).values[storedKeyName(tenantId, version)];
		if (key === undefined) return Promise.reject(new CliError(`${storedKeyName(tenantId, version)} is not stored`));
		const promise = importDataKey(key);
		imported.set(version, promise);
		return promise;
	};
};

export type RotateOptions = {
	limit?: number;
	acceptDestructive?: string;
	report: (line: string) => void;
};

export const rotateKey = async (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	tenantId: string,
	{ limit, acceptDestructive, report }: RotateOptions,
): Promise<RotationProgress> => {
	const { tenant, worker, version: configured } = secretsTarget(project, environment, tenantId);
	const keysFile = keysFileOf(environment);
	const escrow = environmentEscrow(environment);
	const path = progressFile(keysFile, environment.name, tenant.id);
	const scope = { tenantId: tenant.id, environment: worker.vars.TAKEBASE_ENV ?? "" };
	if (scope.environment === "") throw new CliError(`Tenant ${tenant.id} has no TAKEBASE_ENV var in wrangler.jsonc`);
	const store = wranglerStore(deps, project, environment, tenant);
	const keys = keyRing(keysFile, tenant.id);
	const stamp = () => new Date().toISOString();

	if (!environment.remote) {
		const { url } = tenantEndpoint(project, environment, tenant.id);
		if ((await getUrl(deps, `${url}/health`)).status !== 0) {
			throw new CliError("The local stack is running", {
				hint: "Stop it with `pnpm dev:stack:stop` first: each tenant Worker loads its keys when it starts. Nothing was changed.",
			});
		}
	}

	let progress = rotationOf(environment, tenant.id);
	const save = (next: Partial<RotationProgress>) => {
		progress = { ...(progress as RotationProgress), ...next, updated: stamp() };
		writeProgress(path, progress);
		return progress;
	};

	// 1. Create the new key, or continue with the one an interrupted run created.
	if (!unfinished(progress)) {
		const from = activeVersion(project, environment, tenant.id);
		const to = from + 1;
		if (readSecretsFile(keysFile).values[storedKeyName(tenant.id, from)] === undefined) {
			throw new CliError(`${storedKeyName(tenant.id, from)} is not in ${keysFile}`, {
				hint: `Restore it with \`takebase secrets recover ${tenant.id} --env ${environment.name}\` first. Nothing was changed.`,
			});
		}
		const entry = { tenantId: tenant.id, version: to };
		const name = storedKeyName(tenant.id, to);
		let key = readSecretsFile(keysFile).values[name];
		if (key === undefined) {
			key = (await escrow?.withdraw(entry)) ?? generateKey();
			if (escrow !== null && !(await escrow.has(entry))) await escrow.deposit(entry, key);
			addSecret(keysFile, name, key);
		} else if (escrow !== null && !(await escrow.has(entry))) {
			await escrow.deposit(entry, key);
		}
		if (environment.remote) {
			const installed = remoteSecretNames(deps, project, environment, tenant.env);
			if (!installed.includes(workerKeyName(to)))
				uploadKey(deps, project, environment, tenant.env, workerKeyName(to), key);
		}
		const now = stamp();
		progress = {
			tenant: tenant.id,
			environment: environment.name,
			from,
			to,
			phase: "installed",
			started: now,
			updated: now,
			rewrittenAt: null,
			verifiedAt: null,
			counts: { total: 0, onTarget: 0, rewritten: 0, unreadable: 0 },
		};
		writeProgress(path, progress);
		report(
			`Created ${workerKeyName(to)} for tenant ${tenant.id}: ${escrow === null ? "" : `deposited in the ${escrow.label}, `}stored in ${keysFile}${environment.remote ? `, installed on ${worker.workerName}` : ""}.`,
		);
		if (escrow === null) report("  No escrowDir is configured: keep a copy of the keys file elsewhere.");
	}
	let current = progress as RotationProgress;
	const { from, to } = current;

	// 2. Activate it.
	if (current.phase === "installed") {
		if (environment.remote) {
			if (configured !== to) {
				const file = join(project.workers.tenant, "wrangler.jsonc");
				writeFileSync(
					file,
					replaceJsoncProperty(readFileSync(file, "utf8"), ["env", tenant.env, "vars"], "DATA_KEY_VERSION", String(to)),
				);
			}
			deployWorker(deps, project.workers.tenant, tenant.env, environment, tenantSecrets(environment, tenant.id));
			const { url } = tenantEndpoint(project, environment, tenant.id);
			await waitForUrl(deps, `${url}/health`, healthy({ tenantId: tenant.id }));
			// Instances still on the old version may write with the old key until they are replaced.
			await deps.wait(remoteSettleMs);
		}
		current = save({ phase: "activated" });
		report(
			environment.remote
				? `Activated ${workerKeyName(to)}: DATA_KEY_VERSION is ${to} in wrangler.jsonc and ${worker.workerName} is deployed.`
				: `Activated ${workerKeyName(to)}: \`takebase dev\` now writes with it.`,
		);
		if (environment.remote) report(commitReminder(project));
	}

	// 3 and 4. Re-encrypt, then verify; a secret still on the old key goes back to re-encryption.
	for (let pass = 1; current.phase === "activated" || current.phase === "rewritten"; pass++) {
		if (current.phase === "activated") {
			const result = await rewriteSecrets({ store, keys, scope, target: to, now: () => new Date(), limit });
			report(
				`Re-encrypted ${result.rewritten} secret(s) with ${workerKeyName(to)}: ${result.total} stored, ${result.onTarget} already on it, ${result.changed} changed meanwhile, ${result.unreadable} unreadable, ${result.remaining} left.`,
			);
			current = save({
				phase: result.remaining > 0 ? "activated" : "rewritten",
				rewrittenAt: stamp(),
				counts: {
					total: result.total,
					onTarget: result.onTarget,
					rewritten: current.counts.rewritten + result.rewritten,
					unreadable: result.unreadable,
				},
			});
			if (result.remaining > 0) {
				report("  Run the same command again to continue.");
				return current;
			}
		}
		const settle = environment.remote ? remoteSettleMs - (Date.now() - Date.parse(current.rewrittenAt ?? "")) : 0;
		if (settle > 0) await deps.wait(settle);
		const proof = await verifySecrets({ store, keys, scope, target: to });
		const stillOld = proof.needs[from] ?? 0;
		const newer = Object.keys(proof.needs).filter((version) => Number(version) !== from);
		if (newer.length > 0) {
			throw new CliError(`Secrets of tenant ${tenant.id} use key versions ${newer.join(", ")}, not ${from} or ${to}`, {
				hint: "Check `takebase secrets status`. Nothing more was changed.",
			});
		}
		if (stillOld > 0 && pass < maxRewritePasses) {
			report(`  ${stillOld} secret(s) are still on ${workerKeyName(from)}; re-encrypting again.`);
			current = save({ phase: "activated" });
			continue;
		}
		const accepted = acceptDestructive === `${tenant.id}:v${from}`;
		if (!fullyRotated(proof) && !accepted) {
			throw new CliError(
				`${proof.total - proof.onTarget} of ${proof.total} secret(s) of tenant ${tenant.id} do not open with ${workerKeyName(to)}; ${workerKeyName(from)} is not retired`,
				{
					hint: `Retiring ${workerKeyName(from)} anyway can lose them: only if that is intended, rerun with \`--accept-destructive ${tenant.id}:v${from}\`.`,
				},
			);
		}
		current = save({ phase: "verified", verifiedAt: stamp(), counts: { ...current.counts, onTarget: proof.onTarget } });
		report(
			fullyRotated(proof)
				? `Verified: all ${proof.total} secret(s) open with ${workerKeyName(to)}.`
				: `Verified with --accept-destructive: ${proof.onTarget} of ${proof.total} secret(s) open with ${workerKeyName(to)}.`,
		);
	}

	// 5. Retire the old key.
	if (current.phase === "verified") {
		if (environment.remote && remoteSecretNames(deps, project, environment, tenant.env).includes(workerKeyName(from))) {
			const result = deps.run(
				project.workers.tenant,
				"wrangler",
				["secret", "delete", workerKeyName(from), "--env", tenant.env],
				cloudflareEnv(environment),
			);
			if (result.status !== 0) throw new CliError(`wrangler secret delete failed:\n${outputTail(result.output)}`);
		}
		current = save({ phase: "retired" });
		report(
			`Retired ${workerKeyName(from)}${environment.remote ? ` from ${worker.workerName}` : ""}: tenant ${tenant.id} now has one key, ${workerKeyName(to)}.`,
		);
		// A key created before the escrow existed is in the keys file only.
		const escrowed = escrow !== null && (await escrow.has({ tenantId: tenant.id, version: from }));
		report(
			`  ${storedKeyName(tenant.id, from)} stays in the keys file${escrowed ? " and escrow" : ""} as a record only.`,
		);
		report(environment.remote ? commitReminder(project) : "  Start the stack (`pnpm dev:stack`) to load it.");
	}
	return current;
};

// Restores a tenant's lost keys (the active one, and the old one while a
// rotation is unfinished) from the escrow into the keys file and, remotely,
// installs any the Worker is missing.
export const recoverTenantKeys = async (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	tenantId: string,
): Promise<(Recovery & { installed: boolean })[]> => {
	const { tenant, worker } = secretsTarget(project, environment, tenantId);
	const keysFile = keysFileOf(environment);
	const escrow = environmentEscrow(environment);
	if (escrow === null) {
		throw new CliError(`Environment "${environment.name}" has no escrowDir in takebase.jsonc`, {
			hint: "Without an escrow there is nothing to recover from. Nothing was changed.",
		});
	}
	const scope = { tenantId: tenant.id, environment: worker.vars.TAKEBASE_ENV ?? "" };
	const store = wranglerStore(deps, project, environment, tenant);
	const progress = rotationOf(environment, tenant.id);
	const active = activeVersion(project, environment, tenant.id);
	const versions = unfinished(progress) && progress !== null ? [progress.from, progress.to] : [active];
	const installedNames = environment.remote ? remoteSecretNames(deps, project, environment, tenant.env) : [];
	const results: (Recovery & { installed: boolean })[] = [];
	for (const version of new Set(versions)) {
		const recovery = await recoverKey({ escrow, keysFile, store, scope, version });
		let installed = false;
		if (environment.remote && !installedNames.includes(workerKeyName(version))) {
			const key = readSecretsFile(keysFile).values[storedKeyName(tenant.id, version)] ?? "";
			uploadKey(deps, project, environment, tenant.env, workerKeyName(version), key);
			installed = true;
		}
		results.push({ ...recovery, installed });
	}
	return results;
};
