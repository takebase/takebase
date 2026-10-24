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
