import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

type D1Binding = { binding: string; database_name: string; database_id: string };
type ServiceBinding = { binding: string; service: string; entrypoint?: string };
type WranglerEnv = { d1_databases?: D1Binding[]; services?: ServiceBinding[]; vars?: Record<string, string> };
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

	it("each tenant environment has its own local-only D1 database", () => {
		const tenantDatabases = [tenant, ...Object.values(tenant.env ?? {})].map((env) => env.d1_databases ?? []);
		const ids = tenantDatabases.map((databases) => databases.map((db) => db.database_id));
		const allIds = [...ids.flat(), ...(global.d1_databases ?? []).map((db) => db.database_id)];

		expect(Object.keys(tenant.env ?? {}).sort()).toEqual(["tenant-a", "tenant-b"]);
		for (const databases of tenantDatabases) expect(databases.map((db) => db.binding)).toEqual(["DB"]);
		expect(new Set(allIds).size).toBe(allIds.length);
		for (const id of allIds) expect(id).toMatch(/^local-/);
	});

	it("tenants reach the global Worker only over a service binding, and no config trusts the Auth emulator", () => {
		for (const env of [tenant, ...Object.values(tenant.env ?? {})]) {
			expect(env.services).toEqual([{ binding: "GLOBAL", service: global.name, entrypoint: "MembershipEntrypoint" }]);
			expect(Object.keys(env.vars ?? {})).toEqual(["TENANT_ID"]);
		}
		for (const config of [global, tenant, frontend]) {
			for (const env of [config, ...Object.values(config.env ?? {})]) {
				expect(Object.keys(env.vars ?? {}), config.name as string).not.toContain("TAKEBASE_AUTH_EMULATOR");
			}
		}
	});

	it("the frontend is static assets plus SvelteKit only, with no data bindings", () => {
		expect(frontend.assets?.directory).toBe(".svelte-kit/cloudflare");
		for (const key of resourceBindings) expect(frontend[key]).toBeUndefined();
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

	it("only server packages may depend on Drizzle", () => {
		for (const dir of ["packages/contracts", "packages/sdk", "packages/cli", "examples/sveltekit"]) {
			expect(
				dependencyNames(dir).filter((name) => name.startsWith("drizzle")),
				dir,
			).toEqual([]);
		}
	});
});
