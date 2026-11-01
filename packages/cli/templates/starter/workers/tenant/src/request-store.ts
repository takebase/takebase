import { type AuthIdentity, createRequestStore } from "@takebase/core";
import type { AppContext } from "./context.ts";

// Typed per-request locals; add fields here, never free-form keys.
export type RequestLocals = {
	// The verified tenant member, or null for an anonymous request.
	auth: AuthIdentity | null;
	// The tenant's access revision from the same membership check, or null when anonymous.
	accessRevision: number | null;
};

export const { runInRequest, useContext, requestLocals } = createRequestStore<AppContext, RequestLocals>();
