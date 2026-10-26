import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

// The approved staging targets (SEGU-218): Firebase project takebase-eb6e3 and
// takebase-staging-* resources in the shared Cloudflare account. Nothing here is
// secret. Passwords and the web API key live only in the untracked
// ops/.staging.env (mode 600), written by these scripts and never printed.

export const projectId = "takebase-eb6e3";

export const tenants = [
	{ id: "tenant-a", name: "Tenant A", instance: "takebase-staging-tenant-a" },
	{ id: "tenant-b", name: "Tenant B", instance: "takebase-staging-tenant-b" },
] as const;

export type Tenant = (typeof tenants)[number];

export const databaseUrl = (tenant: Tenant) => `https://${tenant.instance}.firebaseio.com`;

// Fixture users, as in the local milestone. `probe` exists only for the
// grant/revoke check, so its revocations never touch alice's or bob's grants.
export const users = {
	alice: { email: "alice@example.test" },
	bob: { email: "bob@example.test" },
	probe: { email: "probe@example.test" },
} as const;

export type UserName = keyof typeof users;

export const dispatcherEmail = (tenant: Tenant) => `takebase-staging-dispatcher-${tenant.id}@example.test`;

// The deployed Workers on the account's workers.dev subdomain (read from the
// first staging deploy's output).
export const workersSubdomain = "info8841";
export const workerUrl = (name: string) => `https://${name}.${workersSubdomain}.workers.dev`;
export const globalUrl = () => workerUrl("takebase-staging-global");
export const appUrl = () => workerUrl("takebase-staging-app");
export const tenantUrl = (tenant: Tenant) => workerUrl(`takebase-staging-${tenant.id}`);

const root = new URL("../", import.meta.url).pathname;
export const opsPath = (name: string) => `${root}ops/${name}`;
const envFile = opsPath(".staging.env");

export const readEnv = (): Record<string, string> => {
	if (!existsSync(envFile)) throw new Error("ops/.staging.env is missing: register the staging web app first");
	const entries = readFileSync(envFile, "utf8")
		.split("\n")
		.filter((line) => line.includes("=") && !line.startsWith("#"))
		.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
	return Object.fromEntries(entries);
};

const writeEnv = (env: Record<string, string>) => {
	writeFileSync(
		envFile,
		`${Object.entries(env)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n")}\n`,
		{ mode: 0o600 },
	);
	chmodSync(envFile, 0o600);
};

export const passwordKey = (label: string) => `STAGING_PASSWORD_${label.toUpperCase().replaceAll("-", "_")}`;

// The stored password for `label`, generated (and saved) on first use.
export const password = (label: string) => {
	const env = readEnv();
	const key = passwordKey(label);
	if (!env[key]) {
		env[key] = randomBytes(24).toString("base64url");
		writeEnv(env);
	}
	return env[key];
};

export const apiKey = () => {
	const key = readEnv().FIREBASE_API_KEY;
	if (!key) throw new Error("FIREBASE_API_KEY is missing from ops/.staging.env");
	return key;
};

const identityToolkit = async (method: string, body: Record<string, unknown>) => {
	const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${apiKey()}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...body, returnSecureToken: true }),
	});
	const data = (await response.json()) as { idToken?: string; localId?: string; error?: { message?: string } };
	return { ok: response.ok, data };
};

export type Session = { uid: string; token: string };

export const signIn = async (email: string, secret: string): Promise<Session> => {
	const { ok, data } = await identityToolkit("signInWithPassword", { email, password: secret });
	if (!ok || !data.idToken || !data.localId) throw new Error(`Sign-in failed for ${email}: ${data.error?.message}`);
	return { uid: data.localId, token: data.idToken };
};

// Creates the user if needed; an existing user must still accept the stored password.
export const ensureUser = async (email: string, secret: string): Promise<Session & { created: boolean }> => {
	const { ok, data } = await identityToolkit("signUp", { email, password: secret });
	if (ok && data.idToken && data.localId) return { uid: data.localId, token: data.idToken, created: true };
	if (data.error?.message !== "EMAIL_EXISTS") throw new Error(`Sign-up failed for ${email}: ${data.error?.message}`);
	return { ...(await signIn(email, secret)), created: false };
};
