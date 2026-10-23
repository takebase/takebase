import type { Rule } from "./types.ts";

export const deny: Rule = () => false;

// Allows any resolved identity; denies anonymous callers.
export const authenticated: Rule = ({ auth }) => auth !== null;
