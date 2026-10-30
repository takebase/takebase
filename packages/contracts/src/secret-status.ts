import type { SecretMetadata, SecretsState } from "./secrets.ts";

// A tenant's secrets as its admins see them (SEGU-227): key state and
// metadata only, never a value or key material. `environment` and `tenantId`
// name the exact target an operator's rotation would act on.
export type TenantSecretsReport = {
	tenantId: string;
	environment: string | null;
	state: SecretsState;
	// The version new secrets use, and the versions installed on the Worker.
	activeKeyVersion: number | null;
	installedKeyVersions: number[];
	secrets: SecretMetadata[];
};
