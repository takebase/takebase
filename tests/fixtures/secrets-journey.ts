import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadProjectConfig, resolveEnvironment } from "../../packages/cli/src/project-config.ts";
import { readSecretsFile } from "../../packages/cli/src/secrets-file.ts";
import { cloudflareEnv } from "../../packages/cli/src/services/environment.ts";
import { storedKeyName } from "../../packages/cli/src/services/key-installation.ts";
import { runAnyTool } from "../../packages/cli/src/worker-target.ts";

// The S-6-1-01 journey (SEGU-223), after `takebase secrets init` for tenant-a
// and tenant-b: each tenant Worker's key opens its own secrets (the readiness
// check writes and decrypts the key-check canary), status and check show
// metadata only, KV holds AES-256-GCM envelopes only, tenant-a's envelope
// substituted into tenant-b's namespace is refused (tenant-b's own is then
// recreated), and a second init is refused. No key is ever printed: every
// output is checked for the keys before it is shown. Remote KV is eventually
// consistent (an edge may serve a changed key's old value for about 60 s), so
// on staging the substitution steps wait for the change to be seen.
//
//   node tests/fixtures/secrets-journey.ts                 local: against `takebase dev`
//   node tests/fixtures/secrets-journey.ts --env staging   staging: the deployed tenant Workers

const envName =
	(process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : undefined) ?? "local";
const root = new URL("../../", import.meta.url).pathname;
const project = loadProjectConfig(root);
const environment = resolveEnvironment(project, envName);
const tenants = ["tenant-a", "tenant-b"].map((id) => {
	const tenant = environment.tenants.find((candidate) => candidate.id === id);
	if (!tenant) throw new Error(`${id} must be declared for ${envName}`);
	return tenant;
});
const [tenantA, tenantB] = tenants as [(typeof tenants)[number], (typeof tenants)[number]];

// The keys, held only to prove they never appear anywhere.
const keys = readSecretsFile(environment.keysFile ?? "").values;
const forbidden = tenants.map(({ id }) => keys[storedKeyName(id, 1)] ?? "");

let failures = 0;
const expect = (label: string, ok: boolean, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${detail}`}`);
};
const leaks = (text: string) => forbidden.some((key) => key !== "" && text.includes(key));
const show = (output: string) => {
	if (leaks(output)) {
		expect("output never contains a data key", false, "withheld");
		return;
	}
	for (const line of output.split("\n")) console.log(`       ${line}`);
};

// `quiet` runs are still checked for keys, but only the last attempt is shown.
const cli = (...args: string[]) => run(args, false);
const run = (args: string[], quiet: boolean) => {
	const result = spawnSync(process.execPath, [join(root, "packages/cli/src/bin.ts"), ...args, "--env", envName], {
		cwd: root,
		encoding: "utf8",
	});
	const output = `${result.stdout}${result.stderr}`.trim();
	if (quiet) {
		if (leaks(output)) expect("output never contains a data key", false, "withheld");
	} else {
		console.log(`     $ takebase ${args.join(" ")} --env ${envName}  (exit ${result.status})`);
		show(output);
	}
	return { status: result.status ?? 1, output };
};

// One tenant's SECRETS namespace through Wrangler (`takebase dev`'s per-tenant state locally).
const kv = (tenant: (typeof tenants)[number], ...args: string[]) => {
	const location = environment.remote
		? ["--remote"]
		: ["--local", "--persist-to", join(project.workers.tenant, ".wrangler", `state-${tenant.id}`)];
	const result = runAnyTool(
		project.workers.tenant,
		"wrangler",
		["kv", "key", ...args, "--binding", "SECRETS", "--env", tenant.env, ...location],
		cloudflareEnv(environment),
	);
	if (result.status !== 0) throw new Error(`wrangler kv key ${args[0]} failed for ${tenant.id}`);
	return result.stdout;
};
// Polls until `done` holds: once locally, for up to 2 minutes remotely.
const eventually = async (done: () => boolean) => {
	const attempts = environment.remote ? 13 : 1;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (done()) return true;
		if (attempt < attempts) await sleep(10_000);
	}
	return false;
};
const checkTenant = (id: string) => run(["secrets", "check", id], true);
const canary = "secret/key-check/canary";
// The stored text, or "" when the key does not exist (yet).
const getValue = (tenant: (typeof tenants)[number], key: string) => {
	let out: string;
	try {
		out = kv(tenant, "get", key, "--text");
	} catch {
		return "";
	}
	return out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
};

console.log(`S-6-1-01 encrypted tenant secrets (${envName})`);
expect(
	"both tenants have a stored data key",
	forbidden.every((key) => key !== ""),
);
expect("the two tenants' keys differ", forbidden[0] !== forbidden[1]);

const checked = cli("secrets", "check");
expect("each tenant's key opens its secrets", checked.status === 0 && !checked.output.includes("FAIL"));

const status = cli("secrets", "status");
expect(
	"status lists the key-check canary as metadata",
	status.status === 0 && (status.output.match(/key-check\/canary {2}key v1/g) ?? []).length === 2,
);

for (const tenant of tenants) {
	let listed: { name: string }[] = [];
	let values: string[] = [];
	// A key can be listed before its value is readable remotely.
	await eventually(() => {
		listed = JSON.parse(kv(tenant, "list").replace(/^[^[]*/, "")) as { name: string }[];
		values = listed.map(({ name }) => getValue(tenant, name));
		return values.every((value) => value !== "");
	});
	const envelopes = values.every((value) => {
		const parsed = (value === "" ? {} : JSON.parse(value)) as Record<string, unknown>;
		return parsed.v === 1 && parsed.alg === "A256GCM" && Object.keys(parsed).sort().join() === "alg,c,kv,n,v";
	});
	expect(`${tenant.id} KV holds only AES-256-GCM envelopes`, listed.length > 0 && envelopes, `${listed.length} key(s)`);
	expect(`${tenant.id} KV contains no data key`, !leaks(JSON.stringify(values)));
}

// Substitution: tenant-a's ciphertext in tenant-b's namespace must not open.
// Readiness says only "error", never why (the reason goes to the redacted log).
const own = getValue(tenantB, canary);
const foreign = getValue(tenantA, canary);
expect("both canaries are readable", own !== "" && foreign !== "");
kv(tenantB, "put", canary, foreign);
const refused = await eventually(() => {
	const { status, output } = checkTenant(tenantB.id);
	return status === 1 && output.includes("secrets: error");
});
cli("secrets", "check", tenantB.id);
expect("tenant-a's envelope is refused by tenant-b", refused);
kv(tenantB, "delete", canary);
const restored = await eventually(() => {
	// The check recreates the canary, so it runs before the read.
	if (checkTenant(tenantB.id).status !== 0) return false;
	const recreated = getValue(tenantB, canary);
	return recreated !== "" && recreated !== own && recreated !== foreign;
});
cli("secrets", "check", tenantB.id);
expect("tenant-b recreates its own canary", restored);

const again = cli("secrets", "init", tenantA.id);
expect("a second init is refused", again.status === 1 && again.output.includes("already installed"));

console.log(failures === 0 ? "\nAll S-6-1-01 checks passed." : `\n${failures} S-6-1-01 check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
