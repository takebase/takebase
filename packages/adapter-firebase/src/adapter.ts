import type { RealtimeAdapter } from "@takebase/core";
import { type FirebaseClient, FirebaseRtdbError, isValidKey } from "@takebase/firebase-rtdb";
import { TENANT_REVOCATION } from "./rules.ts";

// The Firebase implementation of core's RealtimeAdapter, writing the layout in
// rules.ts as the tenant's dispatcher user. The rules enforce every ordering
// guarantee; the adapter only avoids writes that would be rejected or useless.

export type FirebaseRealtimeOptions = {
	client: FirebaseClient;
	// Returned to the client SDK by the session endpoint: never secret.
	connection: Readonly<Record<string, string>>;
	// Compare-and-set rounds before publish gives up and lets the dispatcher retry.
	attempts?: number;
};

const userKey = (uid: string) => {
	if (!isValidKey(uid) || uid === TENANT_REVOCATION) throw new TypeError("invalid realtime user id");
	return uid;
};

const isDenied = (error: unknown) => error instanceof FirebaseRtdbError && error.code === "denied";
const isConflict = (error: unknown) => error instanceof FirebaseRtdbError && error.code === "conflict";

export const createFirebaseRealtime = ({
	client,
	connection,
	attempts = 5,
}: FirebaseRealtimeOptions): RealtimeAdapter => {
	// Writes a revision only if it is newer than the stored one; a concurrent
	// writer makes the ETag stale and this round starts again.
	const publish = async (collection: string, revision: number) => {
		if (!isValidKey(collection)) throw new TypeError("invalid collection name");
		const path = `collections/${collection}`;
		for (let round = 0; round < attempts; round++) {
			const { value, etag } = await client.getWithETag<{ revision?: unknown } | null>(path);
			const current = typeof value?.revision === "number" ? value.revision : 0;
			if (current >= revision) return;
			try {
				await client.setIfUnchanged(path, { revision }, etag);
				return;
			} catch (error) {
				if (!isConflict(error)) throw error;
			}
		}
		throw new Error("Realtime revision kept changing; retry later");
	};

	// A repeated session at the same (or an older) revision writes nothing.
	const grant = async (uid: string, rev: number) => {
		const path = `access/members/${userKey(uid)}`;
		const current = await client.get<{ rev?: unknown } | null>(path);
		if (typeof current?.rev === "number" && current.rev >= rev) return;
		await client.set(path, { rev });
	};

	// One atomic update deletes the grant(s) and records the revocation. The
	// rules reject a revocation older than the stored one; that one already won.
	const revokeAt = async (key: string, fields: Record<string, unknown>, rev: number) => {
		try {
			await client.update("access", { ...fields, [`revoked/${key}`]: rev });
		} catch (error) {
			if (!isDenied(error)) throw error;
			const stored = await client.get<unknown>(`access/revoked/${key}`);
			if (typeof stored !== "number" || stored < rev) throw error;
		}
	};

	const revoke = async (uid: string, rev: number) => {
		const key = userKey(uid);
		await revokeAt(key, { [`members/${key}`]: null }, rev);
		await client.delete(`presence/${key}`);
	};

	const revokeAll = async (rev: number) => {
		await revokeAt(TENANT_REVOCATION, { members: null }, rev);
		await client.delete("presence");
	};

	return { publish, grant, revoke, revokeAll, connection };
};
