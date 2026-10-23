import { createRequestStore } from "@takebase/core";
import type { AppContext } from "./context.ts";

// Typed per-request locals; add fields here, never free-form keys.
export type RequestLocals = Record<never, never>;

export const { runInRequest, useContext, requestLocals } = createRequestStore<AppContext, RequestLocals>();
