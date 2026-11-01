import { existsSync, readFileSync } from "node:fs";
import { loadProjectConfig, resolveEnvironment } from "../packages/cli/src/project-config.ts";
import { readSecretsFile } from "../packages/cli/src/secrets-file.ts";
import { pagesUrl, workerUrl } from "../packages/cli/src/services/environment.ts";

// The production smoke's targets and fixture users (SEGU-231), all synthetic.
// Each user's password is only in its untracked ops/.production/<name>.password
// (mode 600), written by `takebase user create` and never printed.

const root = new URL("../", import.meta.url).pathname;
export const project = loadProjectConfig(root);
export const environment = resolveEnvironment(project, "production");

const [firstTenant] = environment.tenants;
if (firstTenant === undefined) throw new Error("The production environment declares no tenant");
export const tenant = firstTenant;

export const globalUrl = workerUrl(environment, "takebase-prod-global");
export const tenantUrl = workerUrl(environment, `takebase-prod-${tenant.id}`);
export const appUrl = workerUrl(environment, "takebase-prod-app");
export const adminUrl = pagesUrl("takebase-prod-admin");
export const databaseUrl = `https://takebase-prod-${tenant.id}.firebaseio.com`;

export const users = {
	// The tenant's agent and admin.
	agent: { email: `takebase-prod-agent-${tenant.id}@example.test`, roles: ["agent", "admin"] },
	// A member: reads and updates, cannot create or administer.
	member: { email: `takebase-prod-member-${tenant.id}@example.test`, roles: ["member"] },
	// Signed in, but no role anywhere.
	outsider: { email: `takebase-prod-outsider-${tenant.id}@example.test`, roles: [] },
} as const;

export type UserName = keyof typeof users;

// Every smoke record's number starts with this, so cleanup can find them all.
export const recordPrefix = "PRD-";

export const passwordFile = (name: UserName) => `${root}ops/.production/${name}.password`;
export const hasPassword = (name: UserName) => existsSync(passwordFile(name));
export const password = (name: UserName) => readFileSync(passwordFile(name), "utf8").trim();

export type Session = { uid: string; token: string };

export const signIn = async (name: UserName): Promise<Session> => {
	const key = readSecretsFile(environment.secretsFile ?? "").values.FIREBASE_API_KEY;
	const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: users[name].email, password: password(name), returnSecureToken: true }),
	});
	const data = (await response.json()) as { idToken?: string; localId?: string; error?: { message?: string } };
	if (!data.idToken || !data.localId) throw new Error(`Sign-in failed for ${name}: ${data.error?.message}`);
	return { uid: data.localId, token: data.idToken };
};
