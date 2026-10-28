import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { secretsCommand } from "../../packages/cli/src/commands/secrets.ts";
import type { CliIo } from "../../packages/cli/src/errors.ts";
import type { RemoteDeps } from "../../packages/cli/src/services/remote-workers.ts";
import { password } from "../fixtures/tenants.ts";

// `takebase secrets init/status` (SEGU-223) on a throwaway project. Remote
// calls go to a RECORDING RUNNER: it proves which Wrangler calls are made and
// what they carry, not that Cloudflare accepts them (that is staging).
// Keys are random per run: no key-shaped literal is committed.

const account = "acct-pinned";
let root: string;

const write = (path: string, text: string) => {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
};

const tenantEnv = (tenant: string, name?: string) => ({
	...(name === undefined ? {} : { name }),
	vars: { TENANT_ID: tenant, TAKEBASE_ENV: name === undefined ? "local" : "staging", DATA_KEY_VERSION: "1" },
	kv_namespaces: [{ binding: "SECRETS", id: `local-${tenant}-secrets` }],
});

const project = () => {
	write(
		"takebase.jsonc",
		JSON.stringify({
			workers: { global: "global", tenant: "tenant", app: "app" },
			environments: {
				local: {
					remote: false,
					firebaseProject: "demo-test",
					dispatcherEmail: "dispatcher-{tenant}@example.test",
					dispatcherPassword: password,
					globalPort: 18787,
					appPort: 18790,
					keysFile: "keys.env",
					tenants: {
						"tenant-a": { name: "A", env: "tenant-a", port: 18788 },
						"tenant-b": { name: "B", env: "tenant-b", port: 18789 },
					},
				},
				staging: {
					remote: true,
					firebaseProject: "takebase-test",
					namePrefix: "takebase-staging-",
					workersSubdomain: "sub",
					globalEnv: "staging",
					appEnv: "staging",
					secretsFile: "secrets.env",
					dispatcherPasswordKey: "PASSWORD_DISPATCHER_{TENANT}",
					dispatcherEmail: "dispatcher-{tenant}@example.test",
					tenants: { "tenant-a": { name: "A", env: "staging-tenant-a" } },
				},
			},
		}),
	);
	write("secrets.env", `CLOUDFLARE_ACCOUNT_ID=${account}\n`);
	write(
		"tenant/wrangler.jsonc",
		JSON.stringify({
			name: "example-tenant",
			env: {
				"tenant-a": tenantEnv("tenant-a"),
				"tenant-b": tenantEnv("tenant-b"),
				"staging-tenant-a": tenantEnv("tenant-a", "takebase-staging-tenant-a"),
			},
		}),
	);
};

const capture = (stdin?: string) => {
	const out: string[] = [];
	const io: CliIo = {
		stdout: (text) => out.push(text),
		stderr: (text) => out.push(text),
		cwd: root,
		...(stdin === undefined ? {} : { stdin: () => stdin }),
	};
	return { io, text: () => out.join("") };
};

type Call = { args: string[]; env: Record<string, string>; file?: string };

// `installed` lists the Worker secret names `wrangler secret list` reports.
const recorder = (installed: string[] = []) => {
	const calls: Call[] = [];
	const answer = (stdout: string) => ({ status: 0, stdout, output: stdout });
	const deps: RemoteDeps = {
		run: (_dir, _tool, args, env = {}) => {
			const command = args.join(" ");
			// What `secret bulk` uploads, read while the temporary file still exists.
			const file = command.startsWith("secret bulk") ? readFileSync(args[2] ?? "", "utf8") : undefined;
			calls.push({ args, env, ...(file === undefined ? {} : { file }) });
			if (command.startsWith("whoami")) return answer(JSON.stringify({ loggedIn: true, accounts: [{ id: account }] }));
			if (command.startsWith("secret list")) return answer(JSON.stringify(installed.map((name) => ({ name }))));
			if (command.startsWith("kv key list"))
				return answer(
					JSON.stringify([{ name: "secret/key-check/canary", metadata: { kv: 1, updated: "2026-10-28T00:00:00Z" } }]),
				);
			return answer("");
		},
		fetch: async () => new Response("{}"),
		wait: async () => {},
	};
	return { deps, calls };
};

const keysFile = () => readFileSync(join(root, "keys.env"), "utf8");

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "takebase-secrets-"));
	project();
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("takebase secrets init", () => {
	it("stores a strong or given key once (mode 600), never prints it and refuses to replace it", async () => {
		const first = capture();
		expect(await secretsCommand(["init", "tenant-a"], first.io)).toBe(0);
		const generated = /^DATA_KEY_V1_TENANT_A=(.+)$/m.exec(keysFile())?.[1] ?? "";
		expect(Buffer.from(generated, "base64")).toHaveLength(32);
		expect(statSync(join(root, "keys.env")).mode & 0o777).toBe(0o600);
		expect(first.text()).not.toContain(generated);

		const before = keysFile();
		const again = capture();
		await expect(secretsCommand(["init", "tenant-a"], again.io)).rejects.toThrow(
			/never replaces a key|already installed/,
		);
		const replaced = capture(randomBytes(32).toString("base64"));
		await expect(secretsCommand(["init", "tenant-a", "--stdin"], replaced.io)).rejects.toThrow(/Refusing/);
		expect(keysFile()).toBe(before);

		await expect(secretsCommand(["init", "tenant-b", "--stdin"], capture("not a key").io)).rejects.toThrow(/32 bytes/);
		expect(keysFile()).toBe(before);
		const given = randomBytes(32).toString("base64");
		const fromStdin = capture(`${given}\n`);
		expect(await secretsCommand(["init", "tenant-b", "--stdin"], fromStdin.io)).toBe(0);
		expect(keysFile()).toContain(`DATA_KEY_V1_TENANT_B=${given}\n`);
		expect(fromStdin.text()).not.toContain(given);
		// A key is never an argument.
		await expect(secretsCommand(["init", "tenant-b", given], capture().io)).rejects.toThrow(/Usage/);
	});

	it("installs remotely from a removed temporary file, pinned to the account, and refuses an installed key", async () => {
		const { deps, calls } = recorder();
		const out = capture();
		expect(await secretsCommand(["init", "tenant-a", "--env", "staging"], out.io, deps)).toBe(0);
		const key = /^DATA_KEY_V1_TENANT_A=(.+)$/m.exec(readFileSync(join(root, "secrets.env"), "utf8"))?.[1] ?? "";
		expect(key).not.toBe("");
		const bulk = calls.find(({ args }) => args[0] === "secret" && args[1] === "bulk");
		expect(bulk?.args).toEqual(["secret", "bulk", expect.any(String), "--env", "staging-tenant-a"]);
		expect(JSON.parse(bulk?.file ?? "{}")).toEqual({ DATA_KEY_V1: key });
		expect(existsSync(bulk?.args[2] ?? "")).toBe(false);
		for (const call of calls) {
			expect(call.env).toEqual({ CLOUDFLARE_ACCOUNT_ID: account });
			expect(JSON.stringify(call.args)).not.toContain(key);
		}
		expect(out.text()).not.toContain(key);

		// Already installed: nothing is uploaded or stored again.
		const installed = recorder(["DATA_KEY_V1"]);
		const before = readFileSync(join(root, "secrets.env"), "utf8");
		await expect(
			secretsCommand(["init", "tenant-a", "--env", "staging"], capture().io, installed.deps),
		).rejects.toThrow(/already installed/);
		expect(installed.calls.some(({ args }) => args[1] === "bulk")).toBe(false);
		expect(readFileSync(join(root, "secrets.env"), "utf8")).toBe(before);

		// Status shows presence and metadata only.
		const status = capture();
		expect(await secretsCommand(["status", "--env", "staging"], status.io, installed.deps)).toBe(0);
		expect(status.text()).toContain("Worker secret: installed");
		expect(status.text()).toContain("key-check/canary  key v1");
		expect(status.text()).not.toContain(key);
	});
});
