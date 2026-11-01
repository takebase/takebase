import { createRequestStore, type VerifiedIdentity } from "@takebase/core";
import type { AppContext } from "./context.ts";

// Typed per-request locals; add fields here, never free-form keys.
export type RequestLocals = {
	// The verified caller of an admin or invitation route, set by its guard.
	caller: VerifiedIdentity;
};

export const { runInRequest, useContext, requestLocals } = createRequestStore<AppContext, RequestLocals>();
