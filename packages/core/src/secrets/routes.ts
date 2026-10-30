import type { TenantSecretsReport } from "@takebase/contracts";
import { Hono } from "hono";
import { adminGate } from "../diagnostics/routes.ts";
import type { AuthIdentity } from "../rules/types.ts";
import { keyCheckPurpose, type SecretsService } from "../services/secrets-kv-service.ts";

// What the secrets status endpoint needs from the tenant Worker's composition root.
export type SecretsStatusRequest = {
	// The verified tenant member, set by the membership guard; null when anonymous.
	auth: AuthIdentity | null;
	tenantId: string;
	environment: string | null;
	// Null when this Worker has no SECRETS binding or environment.
	secrets: SecretsService | null;
};

export type SecretsRoutesOptions = { resolve: () => SecretsStatusRequest };

// GET /api/admin/secrets (SEGU-227): this tenant's admins only. Whether the
// installed key opens KV, which key versions exist and each stored secret's
// metadata. Nothing is decrypted for the answer except the key-check canary,
// and no value, envelope or key ever leaves the Worker. Rotation stays with
// the operator's CLI: no route changes keys or secrets.
export const createSecretsRoutes = ({ resolve }: SecretsRoutesOptions) => {
	const routes = new Hono();

	routes.get("/api/admin/secrets", async (c) => {
		const { auth, tenantId, environment, secrets } = resolve();
		const refused = adminGate(c, auth);
		if (refused) return refused;
		const versions = secrets?.keyVersions() ?? { active: null, installed: [] };
		const body: TenantSecretsReport = {
			tenantId,
			environment,
			state: secrets ? await secrets.check() : "unconfigured",
			activeKeyVersion: versions.active,
			installedKeyVersions: versions.installed,
			secrets: secrets ? (await secrets.status()).filter(({ purpose }) => purpose !== keyCheckPurpose) : [],
		};
		return c.json(body);
	});

	return routes;
};
