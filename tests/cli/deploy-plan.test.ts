import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectConfig, resolveEnvironment } from "../../packages/cli/src/project-config.ts";
import { deployEnvironment } from "../../packages/cli/src/services/deployment.ts";
import { provisionTenant } from "../../packages/cli/src/services/provisioning.ts";
import { remoteTenantProvider } from "../../packages/cli/src/services/remote-tenant-provider.ts";
import type { RemoteDeps } from "../../packages/cli/src/services/remote-workers.ts";
import { tenantPlan } from "../../packages/cli/src/services/tenant-providers.ts";
import type { Tool } from "../../packages/cli/src/worker-target.ts";

// RECORDING RUNNER: every Wrangler/Firebase call and HTTP request of deploy
// and remote provisioning goes to canned answers and is recorded, so nothing
// leaves the machine. It proves which calls a plan makes, not that Cloudflare
// or Firebase accept them (that is Section G, against approved staging).

const account = "acct-pinned";
const apiKey = "test-api-key";
const password = "test-dispatcher-password";
const adapter = fileURLToPath(new URL("../../packages/adapter-firebase", import.meta.url));

let root: string;

const write = (path: string, text: string) => {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
};

type Overrides = { globalName?: string; tenantDatabase?: string; tenantRealtime?: string };

// A copy of the staging layout: one remote environment, tenant-a provisioned.
const project = ({ globalName, tenantDatabase, tenantRealtime }: Overrides = {}) => {
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
					dispatcherPasswordKey: "PASSWORD_DISPATCHER_{TENANT}",
					dispatcherEmail: "dispatcher-{tenant}@example.test",
					tenants: {
						"tenant-a": { name: "Tenant A", env: "staging-tenant-a" },
						"tenant-c": { name: "Tenant C", env: "staging-tenant-c" },
					},
				},
			},
		}),
	);
	write(
		"secrets.env",
		`CLOUDFLARE_ACCOUNT_ID=${account}\nFIREBASE_API_KEY=${apiKey}\nPASSWORD_DISPATCHER_TENANT_A=${password}\n`,
	);
	const global = globalName ?? "takebase-staging-global";
	write(
		"global/wrangler.jsonc",
		JSON.stringify({
			name: "example-global",
			env: {
				staging: {
					name: global,
					vars: { FIREBASE_PROJECT_ID: "takebase-test" },
					d1_databases: [{ binding: "DB", database_name: "takebase-staging-global", database_id: "g-1" }],
				},
			},
		}),
	);
	write(
		"tenant/wrangler.jsonc",
		JSON.stringify({
			name: "example-tenant",
			d1_databases: [{ binding: "DB", database_name: "x", database_id: "x", migrations_dir: "migrations" }],
			env: {
				"staging-tenant-a": {
					name: "takebase-staging-tenant-a",
					vars: {
						TENANT_ID: "tenant-a",
						FIREBASE_DATABASE_URL: `https://${tenantRealtime ?? "takebase-staging-tenant-a"}.firebaseio.com`,
						CORS_ORIGINS: "https://takebase-staging-app.sub.workers.dev",
					},
					services: [{ binding: "GLOBAL", service: global, entrypoint: "MembershipEntrypoint" }],
					d1_databases: [
						{
							binding: "DB",
							database_name: tenantDatabase ?? "takebase-staging-tenant-a",
							database_id: "t-a",
							migrations_dir: "migrations",
						},
					],
				},
			},
		}),
	);
	mkdirSync(join(root, "tenant/node_modules/@takebase"), { recursive: true });
	symlinkSync(adapter, join(root, "tenant/node_modules/@takebase/adapter-firebase"));
	write("app/wrangler.jsonc", JSON.stringify({ name: "app", env: { staging: { name: "takebase-staging-app" } } }));
	const config = loadProjectConfig(root);
	return { config, environment: resolveEnvironment(config, "staging") };
};

type Call = { tool: Tool | "fetch"; args: string[]; env: Record<string, string> };

const recorder = ({ accounts = [account] }: { accounts?: string[] } = {}) => {
	const calls: Call[] = [];
	const answer = (stdout: string) => ({ status: 0, stdout, output: stdout });
	const deps: RemoteDeps = {
		run: (_dir, tool, args, env = {}) => {
			calls.push({ tool, args, env });
			const command = args.join(" ");
			if (command.startsWith("whoami"))
				return answer(JSON.stringify({ loggedIn: true, accounts: accounts.map((id) => ({ id })) }));
			if (command.startsWith("d1 migrations list"))
				return answer(
					args.includes("staging") ? "0003_tenant_revocations.sql\n0004_trigger.sql" : "No migrations to apply",
				);
			if (command.startsWith("d1 execute")) {
				const tenantA = { id: "tenant-a", status: "active", url: "https://takebase-staging-tenant-a.sub.workers.dev" };
				const asked = /where id = '([^']+)'/.exec(command)?.[1];
				const results = command.includes("from tenants")
					? [tenantA].filter(({ id }) => asked === undefined || id === asked)
					: [{ revision: 0 }];
				return answer(JSON.stringify([{ results }]));
			}
			if (command.startsWith("d1 list"))
				return answer(JSON.stringify([{ name: "takebase-staging-tenant-a", uuid: "t-a" }]));
			if (command.startsWith("database:instances:list"))
				return answer(JSON.stringify({ result: [{ name: "takebase-staging-tenant-a", state: "ACTIVE" }] }));
			if (command.startsWith("database:get")) return answer(JSON.stringify({ rules: {} }));
			return answer("");
		},
		fetch: async (input, init) => {
			const url = String(input);
			calls.push({ tool: "fetch", args: [init?.method ?? "GET", url], env: {} });
			const body = url.includes("accounts:")
				? JSON.stringify(
						url.includes("signInWithPassword") && String(init?.body).includes(password)
							? { localId: "dispatcherA", idToken: "token" }
							: { error: { message: "INVALID_LOGIN_CREDENTIALS" } },
					)
				: url.includes("/health")
					? JSON.stringify({ tenantId: url.includes("tenant-a") ? "tenant-a" : undefined, database: "ok" })
					: url.includes("firebaseio.com")
						? "null"
						: "<html>__sveltekit</html>";
			return new Response(body, { status: body.includes("INVALID") ? 400 : 200 });
		},
		wait: async () => {},
	};
	return { deps, calls };
};

// Calls that only read: anything else changes a remote resource (or, for
// vite, builds locally).
const readOnly = ({ tool, args }: Call) => {
	const [a, b, c] = args;
	if (tool === "fetch") return a === "GET" || (b ?? "").includes("accounts:signInWithPassword");
	if (tool === "firebase") return a === "database:instances:list" || a === "database:get";
	if (tool !== "wrangler") return false;
	if (a === "whoami") return true;
	if (a !== "d1") return false;
	if (b === "list" || (b === "migrations" && c === "list")) return true;
	return b === "execute" && /^select /i.test(args.at(-1) ?? "");
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "takebase-deploy-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("deploy and remote provisioning plans (recording runner)", () => {
	it("deploy --plan makes read-only calls only; a real deploy runs in order, pinned to the account", async () => {
		const { config, environment } = project();
		const planned = recorder();
		const steps = await deployEnvironment(planned.deps, config, environment, { plan: true });
		expect(planned.calls.filter((call) => !readOnly(call))).toEqual([]);
		expect(steps.filter(({ outcome }) => outcome === "would run").map(({ step }) => step)).toEqual([
			"global migrations",
			"global deploy",
			"global check",
			"tenant tenant-a deploy",
			"tenant tenant-a check",
			"app build",
			"app deploy",
			"app check",
		]);
		expect(steps.find(({ step }) => step === "tenant tenant-c")?.outcome).toBe("skipped");

		// The same environment for real: the classifier sees the changes, in order.
		const real = recorder();
		await deployEnvironment(real.deps, config, environment);
		const changes = real.calls.filter((call) => !readOnly(call)).map(({ tool, args }) => `${tool} ${args.join(" ")}`);
		expect(changes.map((change) => change.replace(/--secrets-file \S+/, "--secrets-file <temp>"))).toEqual([
			"wrangler d1 migrations apply DB --remote --env staging",
			"wrangler deploy --env staging",
			"wrangler deploy --env staging-tenant-a --secrets-file <temp>",
			"vite build",
			"wrangler deploy --env staging",
		]);
		const wrangler = real.calls.filter(({ tool }) => tool === "wrangler");
		expect(wrangler.every(({ env }) => env.CLOUDFLARE_ACCOUNT_ID === account)).toBe(true);
		// Secrets travel in a temporary file only, never on a command line.
		expect(real.calls.some(({ args }) => args.some((arg) => arg.includes(password) || arg.includes(apiKey)))).toBe(
			false,
		);
	});

	it("provision --plan of a new remote tenant reads only and writes no file", async () => {
		const { config, environment } = project();
		const before = ["secrets.env", "tenant/wrangler.jsonc"].map((path) => readFileSync(join(root, path), "utf8"));
		const { deps, calls } = recorder();
		const tenant = environment.tenants.find(({ id }) => id === "tenant-c");
		if (!tenant) throw new Error("tenant-c is declared");
		const results = await provisionTenant(
			remoteTenantProvider(config, environment, tenant, deps),
			await tenantPlan(config, environment, tenant),
			{ plan: true },
		);
		expect(calls.filter((call) => !readOnly(call))).toEqual([]);
		expect(results.find(({ step }) => step === "registration")?.outcome).toBe("missing");
		expect(["secrets.env", "tenant/wrangler.jsonc"].map((path) => readFileSync(join(root, path), "utf8"))).toEqual(
			before,
		);
	});

	it("refuses a Cloudflare login that cannot use the pinned account, before any change", async () => {
		const { config, environment } = project();
		const { deps, calls } = recorder({ accounts: ["someone-else"] });
		await expect(deployEnvironment(deps, config, environment)).rejects.toThrow(/cannot use the account/);
		expect(calls.map(({ args }) => args[0])).toEqual(["whoami"]);
	});

	it.each([
		[{ globalName: "seguvin-api" }, /global Worker "seguvin-api"/],
		[{ tenantDatabase: "dbautos-main" }, /D1 database "dbautos-main"/],
		[{ tenantRealtime: "takebase-eb6e3-default-rtdb" }, /Realtime Database "takebase-eb6e3-default-rtdb"/],
	])("refuses a name outside the prefix (%o) before any call", async (overrides, message) => {
		const { config, environment } = project(overrides);
		const { deps, calls } = recorder();
		await expect(deployEnvironment(deps, config, environment, { plan: true })).rejects.toThrow(message);
		expect(calls).toEqual([]);
	});
});
