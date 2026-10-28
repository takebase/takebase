import { env, exports } from "cloudflare:workers";
import { createSecretsService, dataKeysFrom, SecretError } from "@takebase/core";
import { describe, expect, it } from "vitest";

// Encrypted secrets on the Worker's real KV binding (SEGU-223): this tenant's
// envelopes never open as another tenant's, and KV holds no plaintext or key.

// The tenant environments under test always bind SECRETS (wrangler.jsonc).
const secrets = env.SECRETS as KVNamespace;

const dump = async (kv: KVNamespace) => {
	const { keys } = await kv.list();
	return JSON.stringify(
		await Promise.all(keys.map(async ({ name, metadata }) => ({ name, metadata, value: await kv.get(name) }))),
	);
};

const secretsFor = (kv: KVNamespace, tenantId: string) =>
	createSecretsService({
		kv,
		keys: dataKeysFrom(env as unknown as Record<string, unknown>),
		tenantId,
		environment: env.TAKEBASE_ENV ?? "",
		now: () => new Date(),
	});

describe("tenant secrets", () => {
	it("are ready once the key opens the canary, and KV holds only envelopes", async () => {
		const response = await exports.default.fetch("https://tenant.local/health/ready");
		const body = (await response.json()) as { checks: Record<string, string> };
		expect(body.checks.secrets).toBe("ok");
		const { keys } = await secrets.list();
		expect(keys.map(({ name }) => name)).toEqual(["secret/key-check/canary"]);
		expect(JSON.parse((await secrets.get("secret/key-check/canary")) ?? "{}")).toMatchObject({ v: 1, alg: "A256GCM" });
		expect(await dump(secrets)).not.toContain(env.DATA_KEY_V1);
	});

	it("never open as another tenant's, even with the same key", async () => {
		const plaintext = `value-${crypto.randomUUID()}`;
		const own = secretsFor(secrets, env.TENANT_ID);
		await own.put("app", "smtp", plaintext);
		expect(await own.get("app", "smtp")).toBe(plaintext);

		// Copy the raw envelope into the other tenant's namespace.
		await env.OTHER_TENANT_SECRETS.put("secret/app/smtp", (await secrets.get("secret/app/smtp")) ?? "");
		const other = secretsFor(env.OTHER_TENANT_SECRETS, `${env.TENANT_ID}-other`);
		await expect(other.get("app", "smtp")).rejects.toBeInstanceOf(SecretError);

		for (const kv of [secrets, env.OTHER_TENANT_SECRETS]) {
			const stored = await dump(kv);
			expect(stored).not.toContain(plaintext);
			expect(stored).not.toContain(env.DATA_KEY_V1);
		}
	});
});
