import { readdirSync, readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

type D1Binding = { binding: string; database_name: string; database_id: string };
type ServiceBinding = { binding: string; service: string; entrypoint?: string };
type WranglerEnv = {
	name?: string;
	kv_namespaces?: { binding: string; id: string }[];
	d1_databases?: D1Binding[];
	services?: ServiceBinding[];
	vars?: Record<string, string>;
};
type WranglerConfig = WranglerEnv & {
	main: string;
	compatibility_flags?: string[];
	assets?: { directory: string };
	env?: Record<string, WranglerEnv>;
	[key: string]: unknown;
};
type PackageJson = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const wrangler = (dir: string) => parse(read(`${dir}/wrangler.jsonc`)) as WranglerConfig;
const packageJson = (dir: string) => JSON.parse(read(`${dir}/package.json`)) as PackageJson;
const dependencyNames = (dir: string) => {
	const { dependencies = {}, devDependencies = {} } = packageJson(dir);
	return Object.keys({ ...dependencies, ...devDependencies });
};
const runtimeDependencyNames = (dir: string) => Object.keys(packageJson(dir).dependencies ?? {});

const global = wrangler("examples/workers/global");
const tenant = wrangler("examples/workers/tenant");
const frontend = wrangler("examples/sveltekit");

// Bindings that would give a Worker data, storage or service access.
const resourceBindings = [
	"d1_databases",
	"kv_namespaces",
	"r2_buckets",
	"durable_objects",
	"services",
	"queues",
	"hyperdrive",
];

describe("runtime boundaries", () => {
	it("global and tenant Workers are separate entry points with request context support", () => {
		for (const config of [global, tenant]) {
			expect(config.main).toBe("src/index.ts");
			expect(config.compatibility_flags).toContain("nodejs_als");
		}
		expect(global.name).not.toBe(tenant.name);
	});

	// Local environments use local-only D1 ids; the approved staging environments
	// (SEGU-218) use their own remote databases, named takebase-staging-*.
	const isStaging = (name: string) => name.startsWith("staging");
	const tenantEnvs = (staging: boolean) => [
		...(staging ? [] : [tenant]),
		...Object.entries(tenant.env ?? {})
			.filter(([name]) => isStaging(name) === staging)
			.map(([, env]) => env),
	];
	const globalStaging = global.env?.staging;

	it("each tenant environment has its own D1 database: local ids locally, takebase-staging-* in staging", () => {
		expect(Object.keys(tenant.env ?? {}).sort()).toEqual([
			"staging-tenant-a",
			"staging-tenant-b",
			"tenant-a",
			"tenant-b",
		]);
		expect(Object.keys(global.env ?? {})).toEqual(["staging"]);
		const local = [...tenantEnvs(false), global].flatMap((env) => env.d1_databases ?? []);
		const staging = [...tenantEnvs(true), globalStaging ?? {}].flatMap((env) => env.d1_databases ?? []);
		for (const env of [...tenantEnvs(false), ...tenantEnvs(true)]) {
			expect((env.d1_databases ?? []).map((db) => db.binding)).toEqual(["DB"]);
		}
		for (const db of local) expect(db.database_id).toMatch(/^local-/);
		for (const db of staging) {
			expect(db.database_name).toMatch(/^takebase-staging-/);
			expect(db.database_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		}
		const ids = [...local, ...staging].map((db) => db.database_id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(staging).toHaveLength(3);
	});

	it("tenants reach the global Worker only over a service binding, and no config trusts the Auth emulator", () => {
		for (const env of tenantEnvs(false)) {
			expect(env.services).toEqual([{ binding: "GLOBAL", service: global.name, entrypoint: "MembershipEntrypoint" }]);
			// Realtime settings are public; the dispatcher's email and password are secrets only.
			expect(Object.keys(env.vars ?? {})).toEqual([
				"TENANT_ID",
				"FIREBASE_DATABASE_URL",
				"FIREBASE_API_KEY",
				"FIREBASE_DATABASE_NAMESPACE",
				"TAKEBASE_ENV",
				"DATA_KEY_VERSION",
			]);
			// Secrets (SEGU-223): a local KV namespace; the data key is a secret, never a var.
			expect(env.kv_namespaces).toEqual([{ binding: "SECRETS", id: expect.stringMatching(/^local-.*-secrets$/) }]);
		}
		for (const env of tenantEnvs(true)) {
			expect(env.services).toEqual([
				{ binding: "GLOBAL", service: globalStaging?.name, entrypoint: "MembershipEntrypoint" },
			]);
			// In staging the API key and the dispatcher credentials are uploaded secrets.
			expect(Object.keys(env.vars ?? {})).toEqual([
				"TENANT_ID",
				"FIREBASE_DATABASE_URL",
				"CORS_ORIGINS",
				"TAKEBASE_ENV",
				"DATA_KEY_VERSION",
			]);
			// Each tenant's own takebase-staging-<tenant>-secrets namespace (SEGU-223).
			expect(env.kv_namespaces).toEqual([{ binding: "SECRETS", id: expect.stringMatching(/^[0-9a-f]{32}$/) }]);
			expect(env.vars?.FIREBASE_DATABASE_URL).toMatch(/^https:\/\/takebase-staging-[a-z0-9-]+\.firebaseio\.com$/);
		}
		expect(globalStaging?.vars?.FIREBASE_PROJECT_ID).not.toMatch(/^demo-/);
		for (const config of [global, tenant, frontend]) {
			for (const env of [config, ...Object.values(config.env ?? {})]) {
				expect(Object.keys(env.vars ?? {}), config.name as string).not.toContain("TAKEBASE_AUTH_EMULATOR");
				for (const name of Object.keys(env.vars ?? {})) expect(name).not.toMatch(/^DATA_KEY_V[0-9]+$/);
			}
		}
	});

	// D1 exports are plaintext SQL and a binding cannot be limited to one tenant's
	// objects, so only the global Worker may reach the backup bucket (SEGU-227).
	it("only the global Worker binds the backup bucket", () => {
		for (const env of [...tenantEnvs(false), ...tenantEnvs(true)]) {
			expect((env as Record<string, unknown>).r2_buckets).toBeUndefined();
		}
		expect((global as Record<string, unknown>).r2_buckets).toEqual([
			{ binding: "BACKUPS", bucket_name: "takebase-local-backups" },
		]);
		expect((globalStaging as Record<string, unknown>).r2_buckets).toEqual([
			{ binding: "BACKUPS", bucket_name: "takebase-staging-backups" },
		]);
	});

	it("the frontend is static assets plus SvelteKit only, with no data bindings", () => {
		expect(frontend.assets?.directory).toBe(".svelte-kit/cloudflare");
		for (const env of [frontend, ...Object.values(frontend.env ?? {})] as Record<string, unknown>[]) {
			for (const key of resourceBindings) expect(env[key]).toBeUndefined();
		}
	});

	it("the frontend does not depend on the server framework", () => {
		expect(dependencyNames("examples/sveltekit")).not.toContain("@takebase/core");
	});
});

describe("package boundaries", () => {
	it("contracts has no dependencies", () => {
		expect(dependencyNames("packages/contracts")).toEqual([]);
	});

	it("the SDK depends only on contracts", () => {
		expect(dependencyNames("packages/sdk")).toEqual(["@takebase/contracts"]);
	});

	it("the CLI has no runtime dependencies and does not bundle the framework", () => {
		expect(runtimeDependencyNames("packages/cli")).toEqual([]);
		expect(dependencyNames("packages/cli")).not.toContain("@takebase/core");
	});

	it("core speaks only the realtime contract: no Firebase package or code", () => {
		expect(dependencyNames("packages/core").filter((name) => name.includes("firebase"))).toEqual([]);
		const realtime = readdirSync(new URL("../../packages/core/src/realtime", import.meta.url));
		for (const file of realtime) {
			expect(read(`packages/core/src/realtime/${file}`), file).not.toMatch(
				/firebase-rtdb|adapter-firebase|\.settings|onDisconnect/,
			);
		}
	});

	it("the Firebase adapter's Worker entry never loads the Firebase JS SDK", () => {
		const files = readdirSync(new URL("../../packages/adapter-firebase/src", import.meta.url));
		for (const file of files.filter((name) => name !== "client.ts")) {
			expect(read(`packages/adapter-firebase/src/${file}`), file).not.toMatch(/from\s+["']firebase\//);
		}
		expect(read("packages/adapter-firebase/src/index.ts")).not.toMatch(/client/);
	});

	it("only server packages may depend on Drizzle", () => {
		for (const dir of [
			"packages/contracts",
			"packages/sdk",
			"packages/cli",
			"examples/sveltekit",
			"packages/adminui",
		]) {
			expect(
				dependencyNames(dir).filter((name) => name.startsWith("drizzle")),
				dir,
			).toEqual([]);
		}
	});

	it("the admin reaches Takebase only through the public SDK (SEGU-222)", () => {
		expect(dependencyNames("packages/adminui").filter((name) => name.startsWith("@takebase/"))).toEqual([
			"@takebase/adapter-firebase",
			"@takebase/sdk",
		]);
	});
});
