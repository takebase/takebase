// The realtime adapter contract: how committed changes and member access reach
// a realtime service (Firebase RTDB today; others later). Core speaks only these
// operations, never a service's paths, rules or wire format.
//
// `rev` is the tenant's access revision from global D1 (it grows with every
// membership or tenant status change). Adapters must enforce that a grant only
// counts if its `rev` is newer than the last revocation for that user and for
// the whole tenant, so a stale grant can never undo a revocation.
//
// Methods throw when the service cannot be reached or refuses the write; the
// dispatcher keeps the work and retries later.
export type RealtimeAdapter = {
	// Signals that `collection` changed. Revisions never decrease: an adapter
	// ignores a revision lower than or equal to the one already published.
	publish: (collection: string, revision: number) => Promise<void>;
	// Lets user `uid` receive this tenant's signals and presence.
	grant: (uid: string, rev: number) => Promise<void>;
	// Ends `uid`'s access and records `rev`, so older grants are rejected.
	revoke: (uid: string, rev: number) => Promise<void>;
	// Ends every user's access to this tenant (tenant disabled or deleted).
	revokeAll: (rev: number) => Promise<void>;
	// What the client SDK needs to connect, returned by the session endpoint.
	// JSON only and never secret: it reaches the browser.
	connection: Readonly<Record<string, string>>;
};
