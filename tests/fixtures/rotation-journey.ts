import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadProjectConfig, resolveEnvironment } from "../../packages/cli/src/project-config.ts";
import { readSecretsFile } from "../../packages/cli/src/secrets-file.ts";
import { cloudflareEnv, workerEnvironment } from "../../packages/cli/src/services/environment.ts";
import { remoteSecretNames, storedKeyName } from "../../packages/cli/src/services/key-installation.ts";
import { activeVersion, localKeys, wranglerStore } from "../../packages/cli/src/services/key-lifecycle.ts";
import { defaultRemoteDeps } from "../../packages/cli/src/services/remote-workers.ts";
import {
	importDataKey,
	openEnvelope,
	parseEnvelope,
	sealEnvelope,
} from "../../packages/cli/src/services/secret-envelopes.ts";
import { runAnyTool } from "../../packages/cli/src/worker-target.ts";

// The S-6-2-01 journey (SEGU-224) for tenant-a, in steps around `takebase
// secrets rotate` and `recover`, which the smoke script (or the operator on
// staging) runs in between:
//
//   seed     store fixture secrets under the active key (random values)
//   mixed    an interrupted (--limit) rotation left secrets on both keys
//   verify   every secret is on the active key alone, each fixture reads back
//            its value, the Worker holds only that key, and KV holds no key
//   lose     lose the active key: locally its keys-file line; on staging the
//            Worker secret (the keys file there is never rewritten)
//   cleanup  delete the fixture secrets (staging)
//
//   node tests/fixtures/rotation-journey.ts <step> [--env staging]
//
// Values never leave this machine's memory: between steps only their SHA-256
// digests are kept (mode 600, next to the rotation records). No key or value is
// printed.

const [step] = process.argv.slice(2);
const envName =
	(process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : undefined) ?? "local";
const root = new URL("../../", import.meta.url).pathname;
const project = loadProjectConfig(root);
const environment = resolveEnvironment(project, envName);
const tenant = environment.tenants.find((candidate) => candidate.id === "tenant-a");
if (!tenant) throw new Error(`tenant-a must be declared for ${envName}`);
const keysFile = environment.keysFile ?? "";
const scope = {
	tenantId: tenant.id,
	environment: workerEnvironment(project.workers.tenant, tenant.env)?.vars.TAKEBASE_ENV ?? "",
};
const store = wranglerStore(defaultRemoteDeps, project, environment, tenant);
const digestsFile = join(dirname(keysFile), ".rotation", `journey-${envName}-${tenant.id}.json`);
const fixtures = ["smtp", "stripe", "webhook", "github", "slack", "s3"].map((name) => `secret/app/journey-${name}`);

let failures = 0;
const expect = (label: string, ok: boolean, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${detail}`}`);
};
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const storedKey = (version: number) => readSecretsFile(keysFile).values[storedKeyName(tenant.id, version)];
// Every data key in the keys file, held only to prove none is stored in KV.
const allKeys = () =>
	Object.entries(readSecretsFile(keysFile).values)
		.filter(([name]) => name.startsWith("DATA_KEY_V"))
		.map(([, value]) => value);
const binding = (name: string, keyVersion: number) => {
	const [, purpose = "", ...rest] = name.split("/");
	return { ...scope, keyVersion, purpose, name: rest.join("/") };
};
// The key version each stored secret's envelope names.
const versions = async () => {
	const found: Record<string, number> = {};
	for (const name of await store.names()) {
		const value = await store.get(name);
		found[name] = value === null ? 0 : parseEnvelope(value).keyVersion;
	}
	return found;
};
const tally = (found: Record<string, number>) =>
	Object.entries(
		Object.values(found).reduce<Record<number, number>>((counts, version) => {
			counts[version] = (counts[version] ?? 0) + 1;
			return counts;
		}, {}),
	)
		.map(([version, count]) => `${count} on v${version}`)
		.join(", ");

const seed = async () => {
	const version = activeVersion(project, environment, tenant.id);
	const keyText = storedKey(version);
	if (keyText === undefined) throw new Error(`${storedKeyName(tenant.id, version)} is not stored`);
	const key = await importDataKey(keyText);
	const digests: Record<string, string> = {};
	for (const name of fixtures) {
		const value = randomBytes(24);
		digests[name] = digest(value);
		await store.put(name, await sealEnvelope(key, binding(name, version), value), {
			kv: version,
			updated: new Date().toISOString(),
		});
		value.fill(0);
	}
	mkdirSync(dirname(digestsFile), { recursive: true, mode: 0o700 });
	writeFileSync(digestsFile, `${JSON.stringify(digests)}\n`, { mode: 0o600 });
	expect(`seeded ${fixtures.length} fixture secret(s) under v${version}`, true, tally(await versions()));
};

const mixed = async () => {
	const found = await versions();
	const distinct = new Set(Object.values(found));
	expect("an interrupted rotation leaves secrets on both keys", distinct.size === 2, tally(found));
};

const verify = async () => {
	const version = activeVersion(project, environment, tenant.id);
	const found = await versions();
	expect(
		`every secret is on v${version}`,
		Object.values(found).every((kv) => kv === version),
		tally(found),
	);
	const keyText = storedKey(version) ?? "";
	const key = await importDataKey(keyText);
	const digests = JSON.parse(readFileSync(digestsFile, "utf8")) as Record<string, string>;
	let matched = 0;
	for (const [name, expected] of Object.entries(digests)) {
		try {
			const plain = await openEnvelope(key, binding(name, version), parseEnvelope((await store.get(name)) ?? ""));
			if (digest(plain) === expected) matched++;
			plain.fill(0);
		} catch {}
	}
	expect(
		`each fixture reads back its value with v${version} alone`,
		matched === fixtures.length,
		`${matched} of ${fixtures.length}`,
	);
	const installed = environment.remote
		? remoteSecretNames(defaultRemoteDeps, project, environment, tenant.env)
				.filter((name) => /^DATA_KEY_V\d+$/.test(name))
				.map((name) => Number(name.slice(10)))
		: localKeys(project, environment, tenant.id).versions;
	expect(
		`the tenant Worker is given only DATA_KEY_V${version}`,
		installed.length === 1 && installed[0] === version,
		installed.map((v) => `v${v}`).join(", "),
	);
	const stored = await Promise.all(Object.keys(found).map((name) => store.get(name)));
	expect(
		"KV holds no data key",
		allKeys().every((secret) => !stored.join("\n").includes(secret)),
	);
};

const lose = () => {
	const version = activeVersion(project, environment, tenant.id);
	if (environment.remote) {
		// Never the keys file remotely: it is the only copy beside the escrow.
		const result = runAnyTool(
			project.workers.tenant,
			"wrangler",
			["secret", "delete", `DATA_KEY_V${version}`, "--env", tenant.env],
			cloudflareEnv(environment),
		);
		expect(`DATA_KEY_V${version} removed from the tenant Worker`, result.status === 0);
		return;
	}
	const name = storedKeyName(tenant.id, version);
	const lines = readFileSync(keysFile, "utf8").split("\n");
	writeFileSync(keysFile, lines.filter((line) => !line.startsWith(`${name}=`)).join("\n"), { mode: 0o600 });
	expect(`${name} removed from the local keys file`, storedKey(version) === undefined);
};

// Staging only: locally `pnpm dev:stack` (--fresh) starts KV empty.
const cleanup = () => {
	if (!environment.remote) throw new Error("cleanup is for remote environments");
	for (const name of fixtures) {
		const result = runAnyTool(
			project.workers.tenant,
			"wrangler",
			["kv", "key", "delete", name, "--binding", "SECRETS", "--env", tenant.env, "--remote"],
			cloudflareEnv(environment),
		);
		if (result.status !== 0) failures++;
	}
	expect(`deleted the ${fixtures.length} fixture secret(s)`, failures === 0);
};

const steps: Record<string, () => unknown> = { seed, mixed, verify, lose, cleanup };
const run = step === undefined ? undefined : steps[step];
if (run === undefined) {
	console.error("usage: node tests/fixtures/rotation-journey.ts seed|mixed|verify|lose|cleanup [--env <name>]");
	process.exitCode = 2;
} else {
	if (step !== "seed" && step !== "lose" && !existsSync(digestsFile)) throw new Error("Run the seed step first");
	await run();
	console.log(failures === 0 ? `S-6-2-01 ${step}: passed.` : `S-6-2-01 ${step}: ${failures} check(s) failed.`);
	process.exitCode = failures === 0 ? 0 : 1;
}
