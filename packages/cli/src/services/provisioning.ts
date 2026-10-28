import { CliError } from "../errors.ts";

// Tenant provisioning reconciles by detection: there is no step journal. Each
// step first detects whether its resource exists (and matches), creates it only
// when missing, then detects again. A rerun after any failure therefore resumes
// at the first step that is not done. Registration in global D1 is the last
// step, so until every resource exists the tenant is invisible to discovery and
// membership checks: a partial failure can never look ready.

export type WorkerBindings = {
	name?: string;
	vars: Record<string, string>;
	services: { binding: string; service: string; entrypoint: string }[];
	d1_databases: { binding: string; database_name: string; database_id: string; migrations_dir: string }[];
	// The tenant's encrypted secrets (SEGU-223).
	kv_namespaces?: { binding: string; id: string }[];
};

// What SEGU-223 added to every tenant environment. An environment provisioned
// before it, which differs only by lacking these, is extended in place; any
// other difference is still drift.
export const secretsVars = ["TAKEBASE_ENV", "DATA_KEY_VERSION"];

export type BindingAdditions = { vars: Record<string, string>; kv_namespaces?: WorkerBindings["kv_namespaces"] };

export type Registration = { status: string; url: string };

// What a provider can see and do for one tenant of one environment. Detection
// methods only read; the others change exactly one resource. The local
// provider uses the emulators and local D1; tests use an in-memory one.
export type TenantProvider = {
	realtimeDatabase: () => Promise<boolean>;
	createRealtimeDatabase: () => Promise<void>;
	// The dispatcher's uid when it exists and accepts the stored password.
	dispatcher: () => Promise<string | null>;
	createDispatcher: () => Promise<string>;
	// The live rules, or null when none are set.
	rules: () => Promise<unknown>;
	writeRules: (rules: unknown) => Promise<void>;
	// The D1 database's id, or null when it does not exist.
	database: () => Promise<string | null>;
	createDatabase: () => Promise<string>;
	// The secrets KV namespace's id, or null when it does not exist.
	secretsNamespace: () => Promise<string | null>;
	createSecretsNamespace: () => Promise<string>;
	// The tenant's Wrangler environment, or null when it is not defined.
	bindings: () => Promise<WorkerBindings | null>;
	writeBindings: (bindings: WorkerBindings) => Promise<void>;
	// Adds only missing members to an existing environment; never rewrites one.
	extendBindings: (additions: BindingAdditions) => Promise<void>;
	pendingMigrations: () => Promise<number>;
	applyMigrations: () => Promise<void>;
	// True when the Realtime Database holds a revision above the tenant D1's
	// newest outbox revision: D1 started over, and the adapter would drop every
	// signal until it caught up.
	staleSignals: () => Promise<boolean>;
	clearSignals: () => Promise<void>;
	// Null when this environment does not deploy (local: `takebase dev` runs it).
	deployed: (() => Promise<boolean>) | null;
	deploy: () => Promise<void>;
	registration: () => Promise<Registration | null>;
	register: (url: string) => Promise<void>;
};

export type TenantPlan = {
	// Renders the tenant's Database Security Rules for its dispatcher uid.
	rules: (dispatcherUid: string) => unknown;
	// The Wrangler environment the tenant needs, given its D1 database and
	// secrets KV namespace ids.
	bindings: (databaseId: string, secretsNamespaceId: string) => WorkerBindings;
	// The URL to register: the tenant Worker the SDK routes to.
	url: string;
};

export type StepOutcome = "exists" | "created" | "missing" | "unknown" | "skipped";
export type StepResult = { step: string; outcome: StepOutcome; detail: string };

type Detection = { done: boolean; detail: string; skipped?: boolean };
type Step = { name: string; detect: () => Promise<Detection>; apply: () => Promise<void> };

// Deep equality that ignores object key order (arrays keep theirs).
const canonical = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(canonical)
		: typeof value === "object" && value !== null
			? Object.fromEntries(
					Object.entries(value)
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([key, entry]) => [key, canonical(entry)]),
				)
			: value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// The SEGU-223 members `live` lacks, or null when anything else differs.
const missingAdditions = (live: WorkerBindings, expected: WorkerBindings): BindingAdditions | null => {
	const vars = Object.fromEntries(
		secretsVars
			.filter((key) => !(key in (live.vars ?? {})) && key in expected.vars)
			.map((key) => [key, expected.vars[key] ?? ""]),
	);
	const kv_namespaces = live.kv_namespaces === undefined ? expected.kv_namespaces : undefined;
	const extended = {
		...live,
		vars: { ...live.vars, ...vars },
		...(kv_namespaces === undefined ? {} : { kv_namespaces }),
	};
	if (!same(extended, expected)) return null;
	return { vars, ...(kv_namespaces === undefined ? {} : { kv_namespaces }) };
};

const tenantSteps = (provider: TenantProvider, plan: TenantPlan): Step[] => {
	// Values later steps need; detection fills them in.
	let dispatcherUid: string | null = null;
	let databaseId: string | null = null;
	let namespaceId: string | null = null;
	// Set when the environment exists but lacks only the SEGU-223 members.
	let additions: BindingAdditions | null = null;
	const need = <T>(value: T | null, what: string) => {
		if (value === null) throw new Error(`needs the ${what} first`);
		return value;
	};

	return [
		{
			name: "realtime database",
			detect: async () => ({ done: await provider.realtimeDatabase(), detail: "" }),
			apply: () => provider.createRealtimeDatabase(),
		},
		{
			name: "dispatcher user",
			detect: async () => {
				dispatcherUid = await provider.dispatcher();
				return { done: dispatcherUid !== null, detail: dispatcherUid ?? "" };
			},
			apply: async () => {
				dispatcherUid = await provider.createDispatcher();
			},
		},
		{
			name: "realtime rules",
			detect: async () => {
				const live = await provider.rules();
				return { done: same(live, plan.rules(need(dispatcherUid, "dispatcher user"))), detail: "" };
			},
			apply: () => provider.writeRules(plan.rules(need(dispatcherUid, "dispatcher user"))),
		},
		{
			name: "D1 database",
			detect: async () => {
				databaseId = await provider.database();
				return { done: databaseId !== null, detail: databaseId ?? "" };
			},
			apply: async () => {
				databaseId = await provider.createDatabase();
			},
		},
		{
			name: "secrets namespace",
			detect: async () => {
				namespaceId = await provider.secretsNamespace();
				return { done: namespaceId !== null, detail: namespaceId ?? "" };
			},
			apply: async () => {
				namespaceId = await provider.createSecretsNamespace();
			},
		},
		{
			name: "worker bindings",
			detect: async () => {
				additions = null;
				const live = await provider.bindings();
				if (live === null) return { done: false, detail: "" };
				const expected = plan.bindings(need(databaseId, "D1 database"), need(namespaceId, "secrets namespace"));
				if (same(live, expected)) return { done: true, detail: "" };
				additions = missingAdditions(live, expected);
				if (additions !== null) return { done: false, detail: "lacks the secrets bindings" };
				// An existing environment that differs otherwise is drift: never overwrite it.
				throw new CliError("The tenant's Wrangler environment exists but differs from what provisioning expects", {
					hint: `Expected ${JSON.stringify(expected)}; fix wrangler.jsonc by hand, then run provision again.`,
				});
			},
			apply: () =>
				additions !== null
					? provider.extendBindings(additions)
					: provider.writeBindings(
							plan.bindings(need(databaseId, "D1 database"), need(namespaceId, "secrets namespace")),
						),
		},
		{
			name: "tenant migrations",
			detect: async () => {
				const pending = await provider.pendingMigrations();
				return { done: pending === 0, detail: pending === 0 ? "" : `${pending} pending` };
			},
			apply: () => provider.applyMigrations(),
		},
		{
			name: "realtime signals",
			detect: async () => {
				const stale = await provider.staleSignals();
				return { done: !stale, detail: stale ? "older than the tenant database" : "" };
			},
			apply: () => provider.clearSignals(),
		},
		{
			name: "worker deploy",
			detect: async () => {
				const deployed = provider.deployed;
				return deployed === null
					? { done: true, detail: "not deployed in this environment", skipped: true }
					: { done: await deployed(), detail: "" };
			},
			apply: () => provider.deploy(),
		},
		{
			name: "registration",
			detect: async () => {
				const registration = await provider.registration();
				if (registration === null) return { done: false, detail: "" };
				if (registration.url !== plan.url) {
					throw new CliError(`The tenant is registered with ${registration.url}, not ${plan.url}`, {
						hint: "Provisioning never rewrites a registration; correct it by hand if it is wrong.",
					});
				}
				// Provision never enables a disabled tenant.
				return { done: true, detail: registration.status };
			},
			apply: () => provider.register(plan.url),
		},
	];
};

export type ProvisionOptions = {
	// Detect only: report what provisioning would do and change nothing.
	plan?: boolean;
	report?: (result: StepResult) => void;
};

// Runs every step in order and stops at the first failure. In plan mode
// nothing is applied, and a detection that fails (it needs an earlier missing
// resource, or found drift) reports "unknown" with the reason.
export const provisionTenant = async (
	provider: TenantProvider,
	plan: TenantPlan,
	{ plan: planOnly = false, report = () => {} }: ProvisionOptions = {},
): Promise<StepResult[]> => {
	const results: StepResult[] = [];
	const emit = (result: StepResult) => {
		results.push(result);
		report(result);
	};
	for (const step of tenantSteps(provider, plan)) {
		let detected: Detection;
		try {
			detected = await step.detect();
		} catch (error) {
			// A plan reports what it cannot know yet (an earlier step is missing, or
			// drift that provision would stop on) instead of stopping.
			if (planOnly) {
				emit({ step: step.name, outcome: "unknown", detail: error instanceof Error ? error.message : String(error) });
				continue;
			}
			throw error;
		}
		if (detected.done) {
			emit({ step: step.name, outcome: detected.skipped === true ? "skipped" : "exists", detail: detected.detail });
			continue;
		}
		if (planOnly) {
			emit({ step: step.name, outcome: "missing", detail: detected.detail });
			continue;
		}
		await step.apply();
		const after = await step.detect();
		if (!after.done) throw new CliError(`Provisioning step "${step.name}" ran but its result was not found`);
		emit({ step: step.name, outcome: "created", detail: after.detail });
	}
	return results;
};
