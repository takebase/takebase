import type { Rule } from "./types.ts";

// Built-in rules, written as factories like Laravel policy helpers:
//   rules: { list: tenantMember(), create: hasRole("agent"), delete: deny() }
// Each returned rule carries a readable name for `takebase collection inspect`.
const named = (name: string, rule: Rule): Rule => Object.defineProperty(rule, "name", { value: name });

export const deny = () => named("deny", () => false);

// Any verified caller. In a tenant Worker an identity exists only for a
// verified member of that tenant, so this is the same check as tenantMember().
export const authenticated = () => named("authenticated", ({ auth }) => auth !== null);

// A verified member of this tenant (the guard resolves no identity otherwise).
export const tenantMember = () => named("tenantMember", ({ auth }) => auth !== null);

// A tenant member holding at least one of the roles.
export const hasRole = (...roles: [string, ...string[]]) =>
	named(`hasRole(${roles.join(",")})`, ({ auth }) => auth?.roles.some((role) => roles.includes(role)) === true);
