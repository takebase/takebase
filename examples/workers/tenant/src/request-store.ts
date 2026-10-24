import { type AuthIdentity, createRequestStore } from "@takebase/core";
import type { AppContext } from "./context.ts";

// Typed per-request locals; add fields here, never free-form keys.
export type RequestLocals = {
	// The verified tenant member, or null for an anonymous request.
	auth: AuthIdentity | null;
};

export const { runInRequest, useContext, requestLocals } = createRequestStore<AppContext, RequestLocals>();
