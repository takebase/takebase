import { checkMembership } from "@takebase/core";
import { useContext } from "../request-store.ts";

// The membership check tenant Workers call over their service binding.
export const verifyMembership = (token: unknown, tenantId: unknown) => {
	const { identity, db, now } = useContext();
	return checkMembership({ identity, db, now }, token, tenantId);
};
