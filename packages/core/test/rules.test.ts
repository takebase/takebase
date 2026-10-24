import { describe, expect, it } from "vitest";
import { AuthError } from "../src/auth/membership.ts";
import { authorize } from "../src/rules/authorize.ts";
import { deny, hasRole, tenantMember } from "../src/rules/builtins.ts";
import { evaluateRule } from "../src/rules/evaluate.ts";
import type { AuthIdentity, CollectionRules } from "../src/rules/types.ts";

// The example policies collection's rules (R-3-2-01).
const rules: CollectionRules = {
	list: tenantMember(),
	view: tenantMember(),
	create: hasRole("agent"),
	update: tenantMember(),
	delete: deny(),
};
const member: AuthIdentity = { id: "member", provider: "firebase", roles: ["member"] };
const agent: AuthIdentity = { id: "agent", provider: "firebase", roles: ["member", "agent"] };

const allowed = async (auth: AuthIdentity | null) => {
	const result: Record<string, boolean> = {};
	for (const operation of ["list", "view", "create", "update", "delete"] as const) {
		result[operation] = (await evaluateRule(rules, "policies", operation, auth)).allowed;
	}
	return result;
};

describe("collection policy rules (R-3-2-01)", () => {
	it("members list, view and update; agents also create; nobody deletes; anonymous gets nothing", async () => {
		expect(await allowed(null)).toEqual({ list: false, view: false, create: false, update: false, delete: false });
		expect(await allowed(member)).toEqual({ list: true, view: true, create: false, update: true, delete: false });
		expect(await allowed(agent)).toEqual({ list: true, view: true, create: true, update: true, delete: false });
		expect(rules.create?.name).toBe("hasRole(agent)");
	});

	it("authorize() guards custom queries with the same rules: 401 anonymous, 403 identified", async () => {
		const policies = { name: "policies", rules };
		await expect(authorize(policies, "create", agent)).resolves.toBeUndefined();
		await expect(authorize(policies, "list", null)).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
		const denied = await authorize(policies, "delete", agent).catch((error: unknown) => error);
		expect(denied).toBeInstanceOf(AuthError);
		expect(denied).toMatchObject({ code: "forbidden", status: 403 });
	});
});
