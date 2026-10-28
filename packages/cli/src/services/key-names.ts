// Names of a tenant's data key (SEGU-223): the Worker secret and its entry in
// the keys file and escrows.

export const workerKeyName = (version: number) => `DATA_KEY_V${version}`;

// The keys file entry, e.g. DATA_KEY_V1_TENANT_A.
export const storedKeyName = (tenantId: string, version: number) =>
	`${workerKeyName(version)}_${tenantId.toUpperCase().replaceAll("-", "_")}`;
