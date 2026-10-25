// Record change events: minimal invalidation notices, never record contents.
// A subscriber that receives one refetches the record through its own
// authorized request; the event itself grants no access to data.

export type RecordChangeOperation = "create" | "update" | "delete";

export type RecordChangeEvent = {
	// Stable across delivery retries, so consumers can drop duplicates.
	id: string;
	// Increases with every committed change in one tenant database.
	revision: number;
	collection: string;
	operation: RecordChangeOperation;
	// The server-generated random UUID of the changed (or deleted) record.
	recordId: string;
	// When the change committed, as an ISO 8601 string.
	created: string;
};

// POST /api/realtime/session: the caller, as a verified tenant member, may now
// receive this tenant's realtime signals. `connection` is what the SDK's
// realtime adapter needs to connect (e.g. a database URL); never secret.
export type RealtimeSession = {
	uid: string;
	revision: number;
	connection: Record<string, string>;
};
