import { WorkerEntrypoint } from "cloudflare:workers";
import type { MembershipVerifier } from "@takebase/core";
import { createContext } from "./context.ts";
import { runInRequest } from "./request-store.ts";
import { verifyMembership } from "./routes/membership.ts";

// RPC entrypoint for tenant Workers, reachable only through a service binding:
// there is no public URL for it. Each call opens its own request scope.
export class MembershipEntrypoint extends WorkerEntrypoint<CloudflareBindings> implements MembershipVerifier {
	verifyMembership(token: string, tenantId: string) {
		return runInRequest(createContext(this.env), () => verifyMembership(token, tenantId));
	}
}
