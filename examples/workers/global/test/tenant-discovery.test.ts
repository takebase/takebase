import { env } from "cloudflare:workers";
import type { TenantListResponse } from "@takebase/contracts";
import { describe, expect, it } from "vitest";
import { addMember, addTenant, listTenants } from "./fixtures.ts";

// Needs the Firebase Auth emulator: run `pnpm test:emulator` (firebase emulators:exec).
const emulatorHost = env.TEST_AUTH_EMULATOR_HOST;

const signUp = async (email: string) => {
	const response = await fetch(
		`http://${emulatorHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password: "local-only-password", returnSecureToken: true }),
		},
	);
	expect(response.status).toBe(200);
	return (await response.json()) as { idToken: string; localId: string };
};

const tenantIds = async (token?: string) => {
	const response = await listTenants(token);
	if (response.status !== 200) return response.status;
	return ((await response.json()) as TenantListResponse).tenants.map(({ tenant, roles }) => [tenant.id, roles]);
};

describe("tenant discovery (S-3-1-01)", () => {
	it.skipIf(!emulatorHost)("two emulator users discover only their own memberships", async () => {
		const suffix = crypto.randomUUID();
		const ada = await signUp(`ada-${suffix}@example.test`);
		const grace = await signUp(`grace-${suffix}@example.test`);
		await addTenant("north");
		await addTenant("south");
		await addMember("north", ada.localId, "admin");
		await addMember("south", ada.localId, "viewer");
		await addMember("south", grace.localId, "editor");

		expect(await tenantIds(ada.idToken)).toEqual([
			["north", ["admin"]],
			["south", ["viewer"]],
		]);
		expect(await tenantIds(grace.idToken)).toEqual([["south", ["editor"]]]);
		expect(await tenantIds()).toBe(401);
	});
});
