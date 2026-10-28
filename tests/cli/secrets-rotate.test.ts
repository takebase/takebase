import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { secretsCommand } from "../../packages/cli/src/commands/secrets.ts";
import type { CliIo } from "../../packages/cli/src/errors.ts";
import { directoryEscrow } from "../../packages/cli/src/services/key-escrow.ts";
import type { RemoteDeps } from "../../packages/cli/src/services/remote-workers.ts";
import {
	importDataKey,
	openEnvelope,
	parseEnvelope,
	sealEnvelope,
} from "../../packages/cli/src/services/secret-envelopes.ts";
import { randomKey, randomValue } from "../fixtures/secret-store.ts";

// `takebase secrets rotate` and `recover` (SEGU-224) on a throwaway remote
// project. Wrangler is a FAKE: an in-memory KV namespace and Worker secret
// list that answer the calls the CLI makes. It proves the order of steps and
// the refusals, not that Cloudflare accepts them (that is the staging journey).
// Keys and values are random per run.

const account = "acct-pinned";
const scope = { tenantId: "tenant-a", environment: "staging" };
let root: string;

const write = (path: string, text: string) => {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
};

const project = (keyV1: string) => {
	write(
		"takebase.jsonc",
		JSON.stringify({
			workers: { global: "global", tenant: "tenant", app: "app" },
			environments: {
				staging: {
					remote: true,
					firebaseProject: "takebase-test",
					namePrefix: "takebase-staging-",
					workersSubdomain: "sub",
					globalEnv: "staging",
					appEnv: "staging",
					secretsFile: "secrets.env",
					escrowDir: "escrow",
					dispatcherPasswordKey: "PASSWORD_DISPATCHER_{TENANT}",
					dispatcherEmail: "dispatcher-{tenant}@example.test",
					tenants: { "tenant-a": { name: "A", env: "staging-tenant-a" } },
				},
			},
		}),
	);
	write(
		"secrets.env",
		[
			`CLOUDFLARE_ACCOUNT_ID=${account}`,
			`FIREBASE_API_KEY=${randomValue()}`,
			`PASSWORD_DISPATCHER_TENANT_A=${randomValue()}`,
			`DATA_KEY_V1_TENANT_A=${keyV1}`,
			"",
		].join("\n"),
	);
	write(
		"tenant/wrangler.jsonc",
		JSON.stringify({
			name: "example-tenant",
			env: {
				"staging-tenant-a": {
					name: "takebase-staging-tenant-a",
					vars: { TENANT_ID: "tenant-a", TAKEBASE_ENV: "staging", DATA_KEY_VERSION: "1" },
					kv_namespaces: [{ binding: "SECRETS", id: "kv-tenant-a" }],
				},
			},
		}),
	);
};

// A fake Wrangler: KV and Worker secrets in memory; every call is recorded.
const fakeCloudflare = () => {
	const kv = new Map<string, { value: string; metadata?: unknown }>();
	const secrets = new Set(["DATA_KEY_V1"]);
	const calls: string[] = [];
	const answer = (stdout: string) => ({ status: 0, stdout, output: stdout });
	const deps: RemoteDeps = {
		run: (_dir, _tool, args) => {
			const command = args.join(" ");
			calls.push(command);
			if (command.startsWith("whoami")) return answer(JSON.stringify({ loggedIn: true, accounts: [{ id: account }] }));
			if (command.startsWith("secret list")) return answer(JSON.stringify([...secrets].map((name) => ({ name }))));
			if (command.startsWith("secret bulk")) {
				for (const name of Object.keys(JSON.parse(readFileSync(args[2] ?? "", "utf8")))) secrets.add(name);
				return answer("");
			}
			if (command.startsWith("secret delete")) {
				secrets.delete(args[2] ?? "");
				return answer("");
			}
			if (command.startsWith("kv key list")) {
				return answer(JSON.stringify([...kv].map(([name, { metadata }]) => ({ name, metadata }))));
			}
			if (command.startsWith("kv key get")) return answer(kv.get(args[3] ?? "")?.value ?? "Value not found");
			if (command.startsWith("kv key put")) {
				kv.set(args[3] ?? "", { value: args[4] ?? "", metadata: JSON.parse(args[6] ?? "null") });
				return answer("");
			}
			return answer("");
		},
		fetch: async () => new Response(JSON.stringify({ tenantId: "tenant-a", checks: { database: "ok" } })),
		wait: async () => {},
	};
	return { deps, kv, secrets, calls };
};

const capture = () => {
	const out: string[] = [];
	const io: CliIo = { stdout: (text) => out.push(text), stderr: (text) => out.push(text), cwd: root };
	return { io, text: () => out.join("") };
};

// Runs a command; a CliError becomes its message and hint in the output.
const cli = async (deps: RemoteDeps, ...args: string[]) => {
	const { io, text } = capture();
	try {
		const status = await secretsCommand([...args, "--env", "staging"], io, deps);
		return { status, output: text() };
	} catch (error) {
		return { status: 1, output: `${text()}${String(error)}\n${(error as { hint?: string }).hint ?? ""}` };
	}
};

// Three secrets on V1 in the fake KV, as the Worker would have written them.
const seed = async (kv: Map<string, { value: string; metadata?: unknown }>, keyV1: string) => {
	const values: Record<string, string> = {};
	const key = await importDataKey(keyV1);
	for (const name of ["smtp", "stripe", "webhook"]) {
		values[name] = randomValue();
		const binding = { ...scope, keyVersion: 1, purpose: "app", name };
		kv.set(`secret/app/${name}`, {
			value: await sealEnvelope(key, binding, Buffer.from(values[name])),
			metadata: { kv: 1 },
		});
	}
	return values;
};

const storedKey = (version: number) =>
	new RegExp(`^DATA_KEY_V${version}_TENANT_A=(.+)$`, "m").exec(readFileSync(join(root, "secrets.env"), "utf8"))?.[1] ??
	"";

const opens = async (
	kv: Map<string, { value: string }>,
	keyText: string,
	version: number,
	values: Record<string, string>,
) => {
	const key = await importDataKey(keyText);
	for (const [name, value] of Object.entries(values)) {
		const envelope = parseEnvelope(kv.get(`secret/app/${name}`)?.value ?? "");
		const plain = await openEnvelope(key, { ...scope, keyVersion: version, purpose: "app", name }, envelope);
		if (Buffer.from(plain).toString("utf8") !== value) return false;
	}
	return true;
};

let keyV1: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "takebase-rotate-"));
	keyV1 = randomKey();
	project(keyV1);
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("takebase secrets rotate", () => {
	it("escrows, activates, re-encrypts, verifies and retires, resuming a --limit-ed run", async () => {
		const cloud = fakeCloudflare();
		const values = await seed(cloud.kv, keyV1);

		const first = await cli(cloud.deps, "rotate", "tenant-a", "--limit", "2");
		expect(first.status, first.output).toBe(0);
		expect(first.output).toContain('is at "activated"');
		expect(cloud.secrets).toEqual(new Set(["DATA_KEY_V1", "DATA_KEY_V2"]));
		expect(readFileSync(join(root, "tenant/wrangler.jsonc"), "utf8")).toContain('"DATA_KEY_VERSION":"2"');
		expect(cloud.calls.filter((call) => call.startsWith("kv key put"))).toHaveLength(2);

		const second = await cli(cloud.deps, "rotate", "tenant-a");
		expect(second.status, second.output).toBe(0);
		expect(second.output).toContain("Verified: all 3 secret(s) open with DATA_KEY_V2.");
		expect(second.output).toContain("tenant tenant-a now has one key, DATA_KEY_V2");
		expect(cloud.calls.filter((call) => call.startsWith("kv key put"))).toHaveLength(3);
		expect(cloud.calls.filter((call) => call.startsWith("deploy"))).toHaveLength(1);
		expect(cloud.secrets).toEqual(new Set(["DATA_KEY_V2"]));

		// The new key is escrowed and alone opens every value; the old one is kept as a record only.
		const keyV2 = storedKey(2);
		expect(keyV2 !== "" && keyV2 !== keyV1).toBe(true);
		expect(
			(await directoryEscrow(join(root, "escrow"), "staging").withdraw({ tenantId: "tenant-a", version: 2 })) === keyV2,
		).toBe(true);
		expect(await opens(cloud.kv, keyV2, 2, values)).toBe(true);
		expect(storedKey(1) === keyV1).toBe(true);

		const output = [
			first.output,
			second.output,
			cloud.calls.join("\n"),
			readFileSync(join(root, ".rotation/staging-tenant-a.json"), "utf8"),
		].join("\n");
		for (const secret of [keyV1, keyV2, ...Object.values(values)]) expect(output.includes(secret)).toBe(false);
	});

	it("refuses to retire a key still needed unless the destructive step is named exactly", async () => {
		const cloud = fakeCloudflare();
		await seed(cloud.kv, keyV1);
		// A secret no installed key opens (encrypted under another tenant's key).
		const foreign = await sealEnvelope(
			await importDataKey(randomKey()),
			{ ...scope, keyVersion: 1, purpose: "app", name: "lost" },
			Buffer.from(randomValue()),
		);
		cloud.kv.set("secret/app/lost", { value: foreign });

		const refused = await cli(cloud.deps, "rotate", "tenant-a");
		expect(refused.status).toBe(1);
		expect(refused.output).toContain(
			"1 of 4 secret(s) of tenant tenant-a do not open with DATA_KEY_V2; DATA_KEY_V1 is not retired",
		);
		expect(cloud.secrets.has("DATA_KEY_V1")).toBe(true);

		const wrongTarget = await cli(cloud.deps, "rotate", "tenant-a", "--accept-destructive", "tenant-a:v2");
		expect(wrongTarget.status).toBe(1);
		expect(cloud.secrets.has("DATA_KEY_V1")).toBe(true);

		const accepted = await cli(cloud.deps, "rotate", "tenant-a", "--accept-destructive", "tenant-a:v1");
		expect(accepted.status, accepted.output).toBe(0);
		expect(accepted.output).toContain("Verified with --accept-destructive: 3 of 4");
		expect(cloud.secrets).toEqual(new Set(["DATA_KEY_V2"]));
	});
});

describe("takebase secrets recover", () => {
	it("restores a lost key from the escrow and reinstalls it, only after it opens the secrets", async () => {
		const cloud = fakeCloudflare();
		const values = await seed(cloud.kv, keyV1);
		await directoryEscrow(join(root, "escrow"), "staging").deposit({ tenantId: "tenant-a", version: 1 }, keyV1);
		// The keys file and the Worker both lost DATA_KEY_V1.
		write("secrets.env", readFileSync(join(root, "secrets.env"), "utf8").replace(/^DATA_KEY_V1_TENANT_A=.*\n/m, ""));
		cloud.secrets.delete("DATA_KEY_V1");

		const recovered = await cli(cloud.deps, "recover", "tenant-a");
		expect(recovered.status, recovered.output).toBe(0);
		expect(recovered.output).toContain(
			"Restored DATA_KEY_V1 for tenant tenant-a from the escrow: it opens all 3 secret(s)",
		);
		expect(recovered.output).toContain("Installed it again as the Worker secret DATA_KEY_V1.");
		expect(storedKey(1) === keyV1).toBe(true);
		expect(cloud.secrets.has("DATA_KEY_V1")).toBe(true);
		expect(await opens(cloud.kv, storedKey(1), 1, values)).toBe(true);
		expect([recovered.output, cloud.calls.join("\n")].join("\n").includes(keyV1)).toBe(false);
	});
});
