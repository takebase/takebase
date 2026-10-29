import { readFileSync } from "node:fs";
import { loadProjectConfig, resolveEnvironment } from "../../packages/cli/src/project-config.ts";
import { readSecretsFile } from "../../packages/cli/src/secrets-file.ts";
import { backupBucketOf, r2Store } from "../../packages/cli/src/services/backup-export.ts";
import {
	catalogKey,
	manifestKey,
	parseCatalog,
	parseManifest,
} from "../../packages/cli/src/services/backup-manifest.ts";
import { listBackups, verifyBackup } from "../../packages/cli/src/services/backups.ts";
import { cloudflareEnv } from "../../packages/cli/src/services/environment.ts";
import { defaultRemoteDeps } from "../../packages/cli/src/services/remote-workers.ts";

// The S-6-3-01 integrity journey (SEGU-225) on the newest backup of an
// environment, after `takebase backup create`: it holds no key, password or
// secrets-file value; then each damage (a corrupted, a truncated and a missing
// object, a tampered manifest) fails verification and shows as FAILED in list,
// and the original bytes are put back after each, so the backup verifies
// again. Nothing is deleted for good; no value is printed.
//
//   node tests/fixtures/backup-journey.ts                 local R2
//   node tests/fixtures/backup-journey.ts --env staging   the staging bucket

const envName =
	(process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : undefined) ?? "local";
const root = new URL("../../", import.meta.url).pathname;
const project = loadProjectConfig(root);
const environment = resolveEnvironment(project, envName);
const store = r2Store(defaultRemoteDeps, project, environment);
const bucket = backupBucketOf(environment);

let failures = 0;
const expect = (label: string, ok: boolean, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

// Values that must never be in a backup: every key-file and secrets-file value
// that is not also public in the tracked takebase.jsonc (the secrets file also
// holds e.g. the Firebase project id), and the local dispatcher password.
const forbidden = () => {
	const tracked = readFileSync(project.file, "utf8");
	const files = [...new Set([environment.keysFile, environment.secretsFile].filter((file) => file !== undefined))];
	const values = files
		.flatMap((file) => Object.values(readSecretsFile(file).values))
		.filter((value) => !tracked.includes(value));
	return [...new Set([...values, environment.dispatcherPassword ?? ""])].filter((value) => value.length >= 8);
};

const deleteObject = (key: string) => {
	const location = environment.remote
		? ["--remote"]
		: ["--local", "--persist-to", `${project.workers.global}/.wrangler/state-backups`];
	const result = defaultRemoteDeps.run(
		project.workers.global,
		"wrangler",
		["r2", "object", "delete", `${bucket}/${key}`, ...location],
		cloudflareEnv(environment),
	);
	if (result.status !== 0) throw new Error(`wrangler r2 object delete ${key} failed`);
};

const catalog = parseCatalog(
	await store.get(catalogKey).then((bytes) => (bytes === null ? null : new TextDecoder().decode(bytes))),
);
const newest = [...catalog.backups].sort((a, b) => (a.created < b.created ? 1 : -1))[0];
if (newest === undefined) throw new Error(`No backups in ${bucket}: run takebase backup create first`);
const backupId = newest.backupId;
const manifestBytes = (await store.get(manifestKey(backupId))) ?? new Uint8Array();
const manifest = parseManifest(new TextDecoder().decode(manifestBytes));
if (manifest === null) throw new Error(`The manifest of ${backupId} is unreadable`);
console.log(`Backup ${backupId} (${manifest.scope}, ${manifest.parts.length} parts) in ${bucket}`);

const before = await verifyBackup(store, backupId);
expect("the backup verifies before any damage", before.status === "verified", before.problems.join("; "));

const objects = new Map<string, Uint8Array>();
for (const part of manifest.parts) objects.set(part.object.key, (await store.get(part.object.key)) ?? new Uint8Array());
const text = [...objects.values(), manifestBytes].map((bytes) => new TextDecoder().decode(bytes)).join("\n");
const leaks = forbidden().filter((value) => text.includes(value)).length;
expect("no data key, secrets-file value or password is in any object or the manifest", leaks === 0, `${leaks} found`);
const kv = manifest.parts.filter((part) => part.kind === "kv");
expect(
	"tenant secrets are stored as AES-256-GCM envelopes only",
	kv.length === 0 || (kv.every((part) => part.count > 0) && text.includes("A256GCM")),
	kv.map((part) => `${part.target}: ${part.count}`).join(", "),
);

const d1 = manifest.parts.find((part) => part.kind === "d1");
const secretsPart = kv[0];
const config = manifest.parts.find((part) => part.kind === "config");
const damages: [string, string | undefined, (key: string, bytes: Uint8Array) => Promise<void>][] = [
	[
		"a corrupted object",
		d1?.object.key,
		async (key, bytes) => {
			const changed = new Uint8Array(bytes);
			changed[changed.length - 2] = (changed[changed.length - 2] ?? 0) ^ 1;
			await store.put(key, changed, "application/sql");
		},
	],
	[
		"a truncated object",
		(secretsPart ?? d1)?.object.key,
		async (key, bytes) => store.put(key, bytes.slice(0, Math.floor(bytes.length / 2)), "application/octet-stream"),
	],
	["a missing object", config?.object.key, async (key) => deleteObject(key)],
	[
		"a tampered manifest",
		manifestKey(backupId),
		async (key, bytes) => {
			const tampered = new TextDecoder()
				.decode(bytes)
				.replace(`"environment": "${environment.name}"`, '"environment": "other"');
			await store.put(key, new TextEncoder().encode(tampered), "application/json");
		},
	],
];

for (const [label, key, damage] of damages) {
	if (key === undefined) continue;
	const original = key === manifestKey(backupId) ? manifestBytes : (objects.get(key) ?? new Uint8Array());
	await damage(key, original);
	const verification = await verifyBackup(store, backupId);
	const listed = (await listBackups(store)).find(({ entry }) => entry.backupId === backupId);
	expect(
		`${label} fails verify and is listed as FAILED`,
		verification.status === "failed" && listed?.verification.status === "failed",
		verification.problems.join("; "),
	);
	await store.put(key, original, key.endsWith(".json") ? "application/json" : "application/octet-stream");
	const again = await verifyBackup(store, backupId);
	expect(`the original bytes put back verify again`, again.status === "verified", again.problems.join("; "));
}

console.log(failures === 0 ? "S-6-3-01 integrity: passed." : `S-6-3-01 integrity: ${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
