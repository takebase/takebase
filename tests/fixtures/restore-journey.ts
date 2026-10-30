import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadProjectConfig, resolveEnvironment } from "../../packages/cli/src/project-config.ts";
import { readSecretsFile } from "../../packages/cli/src/secrets-file.ts";
import { exportD1Of, r2Store } from "../../packages/cli/src/services/backup-export.ts";
import {
	catalogKey,
	manifestKey,
	parseCatalog,
	parseManifest,
} from "../../packages/cli/src/services/backup-manifest.ts";
import { contentDigest } from "../../packages/cli/src/services/backups.ts";
import { queryD1, workerEnvironment } from "../../packages/cli/src/services/environment.ts";
import { wranglerStore } from "../../packages/cli/src/services/key-lifecycle.ts";
import { storedKeyName } from "../../packages/cli/src/services/key-names.ts";
import { defaultRemoteDeps } from "../../packages/cli/src/services/remote-workers.ts";
import {
	discardRestore,
	listRestores,
	type RestoreProgress,
	restoresDir,
} from "../../packages/cli/src/services/restore-execution.ts";
import { importDataKey, openEnvelope, parseEnvelope } from "../../packages/cli/src/services/secret-envelopes.ts";

// The S-6-4-01 journey (SEGU-226) around `takebase backup restore`, in steps
// the smoke script (or the operator on staging) runs in between:
//
//   records  local, stack up: alice creates journey policies in tenant-a
//   before   fingerprint the source: tenant-a's and the global database, tenant-a's
//            secrets and every object of the newest backup
//   verify   after the restore: the source fingerprint is unchanged; the restore
//            records are proved; the restored tenant database holds the journey
//            policies (local) and the restored namespace opens the rotation
//            journey's fixture secrets to their recorded digests
//   app      local, stack up with `takebase dev --restored tenant-a`: carol (admin)
//            signs in and refetches the journey policies from the restored copy;
//            alice writes one more, which lands in the copy, and tenant-a's own
//            state and the backup stay unchanged (the running stack writes the
//            live global database, so it is not compared here)
//   cleanup  discard the restores of the newest backup
//
//   node tests/fixtures/restore-journey.ts <step> [--env staging]
//
// Values stay in memory; the journey file holds ids and digests only. No key,
// password or secret value is printed.

const [step] = process.argv.slice(2);
const envName =
	(process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : undefined) ?? "local";
const root = new URL("../../", import.meta.url).pathname;
const project = loadProjectConfig(root);
const environment = resolveEnvironment(project, envName);
const tenant = environment.tenants.find(({ id }) => id === "tenant-a");
if (!tenant) throw new Error(`tenant-a must be declared for ${envName}`);
const deps = defaultRemoteDeps;
const store = r2Store(deps, project, environment);
const journeyFile = join(restoresDir(project), `journey-${envName}.json`);
const rotationDigests = join(project.root, "ops", ".rotation", `journey-${envName}-${tenant.id}.json`);
const tenantState = join(project.workers.tenant, ".wrangler", `state-${tenant.id}`);
const globalState = join(project.workers.global, ".wrangler", "state");
const vars = workerEnvironment(project.workers.tenant, tenant.env)?.vars ?? {};

let failures = 0;
const expect = (label: string, ok: boolean, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${detail}`}`);
};
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
type Journey = { policies: string[]; fingerprint?: Record<string, string> };
const journey = (): Journey =>
	existsSync(journeyFile) ? (JSON.parse(readFileSync(journeyFile, "utf8")) as Journey) : { policies: [] };
const saveJourney = (value: Journey) => {
	mkdirSync(restoresDir(project), { recursive: true, mode: 0o700 });
	writeFileSync(journeyFile, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
};

const newestBackup = async () => {
	const bytes = await store.get(catalogKey);
	const catalog = parseCatalog(bytes === null ? null : new TextDecoder().decode(bytes));
	const newest = [...catalog.backups].sort((a, b) => (a.created < b.created ? 1 : -1))[0];
	if (newest === undefined) throw new Error("No backups: run takebase backup create first");
	return newest.backupId;
};

// Every file of a local state directory, by content (the stack is down).
const files = (dir: string): [string, string][] =>
	existsSync(dir)
		? readdirSync(dir, { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => join(entry.parentPath, entry.name))
				.sort()
				.map((path) => [relative(project.root, path), sha(readFileSync(path))])
		: [];

const fingerprint = async () => {
	const print: Record<string, string> = {};
	if (environment.remote) {
		// The source databases exported again (contents, not bytes) and tenant-a's secrets.
		print["d1 global"] = sha(JSON.stringify(contentDigest(exportD1Of(deps, project, environment, "global"))));
		print["d1 tenant-a"] = sha(JSON.stringify(contentDigest(exportD1Of(deps, project, environment, tenant.id))));
	} else {
		for (const [path, digest] of [...files(tenantState), ...files(globalState)]) print[path] = digest;
	}
	const secrets = wranglerStore(deps, project, environment, tenant);
	for (const name of await secrets.names()) print[`kv ${sha(name)}`] = sha((await secrets.get(name)) ?? "");
	const backupId = await newestBackup();
	const manifest = parseManifest(
		new TextDecoder().decode((await store.get(manifestKey(backupId))) ?? new Uint8Array()),
	);
	print[catalogKey] = sha((await store.get(catalogKey)) ?? "");
	for (const part of manifest?.parts ?? []) print[part.object.key] = sha((await store.get(part.object.key)) ?? "");
	return print;
};

const restoredTenant = async (): Promise<RestoreProgress | undefined> => {
	const backupId = await newestBackup();
	return listRestores(project, envName).find(
		(progress) => progress.backupId === backupId && progress.target.kind === "tenant",
	);
};

const restoredPolicies = (progress: RestoreProgress) =>
	queryD1(project.workers.tenant, tenant.env, environment, "SELECT id FROM policies", undefined, progress.database).map(
		(row) => String(row.id),
	);

const tenantUrl = `http://localhost:${tenant.port}`;
const signIn = async (email: string) => {
	const response = await fetch(
		`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099"}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password: environment.dispatcherPassword, returnSecureToken: true }),
		},
	);
	const body = (await response.json()) as { idToken?: string };
	if (!body.idToken) throw new Error(`Sign-in failed for ${email}`);
	return body.idToken;
};
const call = async (path: string, token: string, method = "GET", body?: unknown) => {
	const response = await fetch(`${tenantUrl}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> | null };
};
const listed = async (token: string) => {
	const page = await call("/api/collections/policies/records?perPage=100", token);
	return { status: page.status, ids: ((page.json?.items ?? []) as { id: string }[]).map(({ id }) => id) };
};
const createPolicy = async (token: string, number: string) => {
	const created = await call("/api/collections/policies/records", token, "POST", {
		number,
		holder: "Restore Journey Holder",
		status: "pending",
	});
	return { status: created.status, id: String(created.json?.id ?? "") };
};

const records = async () => {
	const alice = await signIn("alice@example.test");
	const ids: string[] = [];
	for (let i = 0; i < 3; i++) {
		const created = await createPolicy(alice, `RESTORE-${Date.now().toString(36)}-${i}`);
		if (created.status === 201) ids.push(created.id);
	}
	expect("alice creates 3 journey policies in tenant-a", ids.length === 3);
	saveJourney({ ...journey(), policies: ids });
};

const before = async () => {
	const print = await fingerprint();
	saveJourney({ ...journey(), fingerprint: print });
	expect("source fingerprinted", Object.keys(print).length > 2, `${Object.keys(print).length} entries`);
};

const verify = async () => {
	const recorded = journey().fingerprint ?? {};
	const now = await fingerprint();
	const changed = [...new Set([...Object.keys(recorded), ...Object.keys(now)])].filter(
		(key) => recorded[key] !== now[key],
	);
	expect(
		"the source databases, secrets and backup objects are unchanged",
		Object.keys(recorded).length > 0 && changed.length === 0,
		changed.length === 0 ? `${Object.keys(now).length} entries` : changed.slice(0, 5).join(", "),
	);
	const backupId = await newestBackup();
	const restores = listRestores(project, envName).filter((progress) => progress.backupId === backupId);
	expect(
		"the tenant and global restores of the newest backup are proved",
		restores.length === 2 && restores.every((progress) => progress.step === "proved"),
		restores.map((progress) => `${progress.target.kind}: ${progress.step}`).join(", "),
	);
	const progress = restores.find((candidate) => candidate.target.kind === "tenant");
	if (progress === undefined) return;
	const record = readFileSync(join(restoresDir(project), `${envName}-${progress.restoreId}.json`), "utf8");
	const keyValues = Object.values(readSecretsFile(environment.keysFile ?? "").values).filter((v) => v.length >= 16);
	expect(
		"the progress record holds no key",
		keyValues.every((value) => !record.includes(value)),
	);
	if (!environment.remote) {
		const restored = restoredPolicies(progress);
		const wanted = journey().policies;
		expect(
			"the restored tenant database holds the journey policies",
			wanted.length > 0 && wanted.every((id) => restored.includes(id)),
			`${restored.length} policies`,
		);
	}
	if (!existsSync(rotationDigests)) {
		console.log("     (no rotation journey digests here: decryption is proved by the restore itself)");
		return;
	}
	const digests = JSON.parse(readFileSync(rotationDigests, "utf8")) as Record<string, string>;
	const namespace = environment.remote
		? ["--namespace-id", progress.namespaceId ?? "", "--remote"]
		: ["--binding", "SECRETS", "--env", tenant.env, "--local", "--persist-to", progress.namespace ?? ""];
	const restored = wranglerStore(deps, project, environment, tenant, namespace);
	// Only the fixtures this backup holds (a digests file may predate a cleanup).
	const present = new Set(await restored.names());
	const fixtures = Object.entries(digests).filter(([name]) => present.has(name));
	if (fixtures.length === 0) {
		console.log("     (this backup holds no rotation journey fixtures: decryption is proved by the restore itself)");
		return;
	}
	let matched = 0;
	for (const [name, expected] of fixtures) {
		const stored = await restored.get(name);
		if (stored === null) continue;
		const envelope = parseEnvelope(stored);
		const keyText = readSecretsFile(environment.keysFile ?? "").values[storedKeyName(tenant.id, envelope.keyVersion)];
		if (keyText === undefined) continue;
		const [, purpose = "", ...rest] = name.split("/");
		try {
			const plain = await openEnvelope(
				await importDataKey(keyText),
				{
					tenantId: tenant.id,
					environment: vars.TAKEBASE_ENV ?? "",
					keyVersion: envelope.keyVersion,
					purpose,
					name: rest.join("/"),
				},
				envelope,
			);
			if (sha(plain) === expected) matched++;
			plain.fill(0);
		} catch {}
	}
	expect(
		"the restored secrets decrypt to the known fixture values",
		matched === fixtures.length,
		`${matched} of ${fixtures.length}`,
	);
};

const app = async () => {
	const health = await fetch(`${tenantUrl}/health`).catch(() => null);
	expect("tenant-a answers", health?.ok === true);
	const carol = await signIn("carol@example.test");
	const seen = await listed(carol);
	const wanted = journey().policies;
	expect(
		"carol signs in and refetches the journey policies from the restored tenant",
		seen.status === 200 && wanted.length > 0 && wanted.every((id) => seen.ids.includes(id)),
		`HTTP ${seen.status}, ${seen.ids.length} policies`,
	);
	const bob = await signIn("bob@example.test");
	const bobCreates = await createPolicy(bob, `RESTORE-BOB-${Date.now().toString(36)}`);
	expect(
		"bob (member) still may not create a policy in the restored tenant",
		bobCreates.status === 403,
		`HTTP ${bobCreates.status}`,
	);
	const alice = await signIn("alice@example.test");
	const written = await createPolicy(alice, `RESTORE-AFTER-${Date.now().toString(36)}`);
	const progress = await restoredTenant();
	const globalPrefix = relative(project.root, globalState);
	const recorded = journey().fingerprint ?? {};
	const now = await fingerprint();
	const changed = Object.keys({ ...recorded, ...now }).filter(
		(key) => !key.startsWith(globalPrefix) && recorded[key] !== now[key],
	);
	expect(
		"tenant-a's own state, its secrets and the backup are unchanged while the copy serves",
		Object.keys(recorded).length > 0 && changed.length === 0,
		changed.slice(0, 5).join(", "),
	);
	expect(
		"alice's new policy lands in the restored copy",
		written.status === 201 && progress !== undefined && restoredPolicies(progress).includes(written.id),
		`HTTP ${written.status}`,
	);
};

const cleanup = async () => {
	const backupId = await newestBackup();
	const restores = listRestores(project, envName).filter((progress) => progress.backupId === backupId);
	for (const progress of restores)
		discardRestore(deps, project, environment, progress.restoreId, (line) => console.log(`     ${line}`));
	expect(
		"the restores of the newest backup are discarded",
		listRestores(project, envName).every((p) => p.backupId !== backupId),
	);
};

const steps: Record<string, () => Promise<void>> = { records, before, verify, app, cleanup };
const run = step === undefined ? undefined : steps[step];
if (run === undefined) {
	console.error("usage: node tests/fixtures/restore-journey.ts records|before|verify|app|cleanup [--env <name>]");
	process.exit(2);
}
await run();
console.log(failures === 0 ? `S-6-4-01 ${step}: passed.` : `S-6-4-01 ${step}: ${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
