import { WorkerEntrypoint } from "cloudflare:workers";
import type { MemberRevocation, MembershipVerifier, RevocationSource } from "@takebase/core";
import { createContext } from "./context.ts";
import { runInRequest } from "./request-store.ts";
import { verifyMembership } from "./routes/membership.ts";
import {
	confirmMemberRevocation,
	confirmRevocation,
	pendingMemberRevocations,
	pendingRevocation,
} from "./routes/revocations.ts";

// RPC entrypoint for tenant Workers, reachable only through a service binding:
// there is no public URL for it. Each call opens its own request scope.
export class MembershipEntrypoint
	extends WorkerEntrypoint<CloudflareBindings>
	implements MembershipVerifier, RevocationSource
{
	verifyMembership(token: string, tenantId: string) {
		return runInRequest(createContext(this.env), () => verifyMembership(token, tenantId));
	}

	pendingRevocation(tenantId: string) {
		return runInRequest(createContext(this.env), () => pendingRevocation(tenantId));
	}

	confirmRevocation(tenantId: string, rev: number) {
		return runInRequest(createContext(this.env), () => confirmRevocation(tenantId, rev));
	}

	pendingMemberRevocations(tenantId: string) {
		return runInRequest(createContext(this.env), () => pendingMemberRevocations(tenantId));
	}

	confirmMemberRevocation(tenantId: string, revocation: MemberRevocation) {
		return runInRequest(createContext(this.env), () => confirmMemberRevocation(tenantId, revocation));
	}
}
