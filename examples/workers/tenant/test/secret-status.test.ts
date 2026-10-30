import { env } from "cloudflare:workers";
import type { ErrorEnvelope, TenantSecretsReport } from "@takebase/contracts";
import {
	createSecretsService,
	dataKeysFrom,
	type MembershipCheck,
	type MembershipVerifier,
	type RevocationSource,
} from "@takebase/core";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.ts";

// SEGU-227: the secret status admins read is private to this tenant's admins
// and carries key state and metadata only.

// The tenant environments under test always bind SECRETS (wrangler.jsonc).
const secrets = env.SECRETS as KVNamespace;

// The global Worker as the tenant sees it: membership answers by token.
const member = (roles: string[]): MembershipCheck => ({
	status: "member",
	identity: { id: `uid-${roles.join("-")}`, provider: "firebase", roles },
	revision: 1,
});
const answers: Record<string, MembershipCheck> = {
	admin: member(["admin"]),
	member: member(["member"]),
	// An admin of another tenant is not a member of this one.
	"other-admin": { status: "not_member", subject: "uid-other-admin", revision: 1 },
};
const global: MembershipVerifier & RevocationSource = {
	verifyMembership: async (token) => answers[token] ?? { status: "invalid_token" },
	pendingRevocation: async () => null,
	confirmRevocation: async () => {},
	pendingMemberRevocations: async () => [],
	confirmMemberRevocation: async () => {},
};
const send = (token?: string) =>
	app.fetch(
		new Request("https://tenant.local/api/admin/secrets", {
			headers: token ? { authorization: `Bearer ${token}` } : {},
		}),
		{ ...env, GLOBAL: global },
	);

describe("secret status for admins (SEGU-227)", () => {
	it("only this tenant's admins read it, and it holds metadata only", async () => {
		for (const [token, status, error] of [
			[undefined, 401, "unauthenticated"],
			["member", 403, "forbidden"],
			["other-admin", 403, "forbidden"],
		] as const) {
			const refused = await send(token);
			expect([refused.status, ((await refused.json()) as ErrorEnvelope).error.code]).toEqual([status, error]);
		}

		const plaintext = `value-${crypto.randomUUID()}`;
		await createSecretsService({
			kv: secrets,
			keys: dataKeysFrom(env as unknown as Record<string, unknown>),
			tenantId: env.TENANT_ID,
			environment: env.TAKEBASE_ENV ?? "",
			now: () => new Date(),
		}).put("app", "smtp", plaintext);
		const response = await send("admin");
		expect(response.status).toBe(200);
		const text = await response.text();
		const envelope = JSON.parse((await secrets.get("secret/app/smtp")) ?? "{}") as { n: string; c: string };
		for (const forbidden of [plaintext, env.DATA_KEY_V1, envelope.n, envelope.c, '"c"', '"n"']) {
			expect(text).not.toContain(forbidden);
		}
		const report = JSON.parse(text) as TenantSecretsReport;
		expect(report).toEqual({
			tenantId: env.TENANT_ID,
			environment: env.TAKEBASE_ENV,
			state: "ok",
			activeKeyVersion: 1,
			installedKeyVersions: [1],
			secrets: [{ purpose: "app", name: "smtp", keyVersion: 1, updated: expect.any(String) }],
		});
	});
});
