import type { RecordChangeEvent } from "@takebase/contracts";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { toRecordChangeEvent } from "../realtime/events.ts";
import { outbox } from "../realtime/outbox.ts";
import { type AnyD1Database, createDatabase } from "../storage/d1.ts";

// Dispatcher side of the tenant outbox: claim, acknowledge, retry.
// Delivery is at least once. A dispatcher that dies keeps its events only
// until the lease expires; then another dispatcher claims them again.

export type ClaimOptions = { limit: number; leaseMs: number; now: Date };
// `attempts` counts claims so far, including this one; retry backoff grows with it.
export type ClaimedEvent = RecordChangeEvent & { attempts: number };
export type RetryOptions = { retryAt: Date; maxAttempts: number };

export const createOutboxService = (d1: AnyD1Database) => {
	const db = createDatabase(d1);
	const held = (token: string) => and(eq(outbox.lease_token, token), eq(outbox.status, "pending"));

	// One UPDATE selects and leases the events, so SQLite serializes concurrent
	// claims: two dispatchers never hold the same event under live leases.
	const claim = async ({ limit, leaseMs, now }: ClaimOptions) => {
		const token = crypto.randomUUID();
		const at = now.toISOString();
		const claimable = db
			.select({ seq: outbox.seq })
			.from(outbox)
			.where(
				and(
					eq(outbox.status, "pending"),
					lte(outbox.available_at, at),
					or(isNull(outbox.lease_until), lte(outbox.lease_until, at)),
				),
			)
			.orderBy(asc(outbox.seq))
			.limit(limit);
		const rows = await db
			.update(outbox)
			.set({
				lease_token: token,
				lease_until: new Date(now.getTime() + leaseMs).toISOString(),
				attempts: sql`${outbox.attempts} + 1`,
			})
			.where(inArray(outbox.seq, claimable))
			.returning();
		rows.sort((a, b) => a.seq - b.seq);
		const events: ClaimedEvent[] = rows.map((row) => ({ ...toRecordChangeEvent(row), attempts: row.attempts }));
		return { token, events };
	};

	// Only the current lease holder can acknowledge; returns the ids it marked delivered.
	const acknowledge = async (token: string, ids: string[], now: Date) => {
		if (ids.length === 0) return [];
		const rows = await db
			.update(outbox)
			.set({ status: "delivered", delivered_at: now.toISOString(), lease_token: null, lease_until: null })
			.where(and(held(token), inArray(outbox.id, ids)))
			.returning({ id: outbox.id });
		return rows.map((row) => row.id);
	};

	// Releases a failed event for a later attempt, or parks it as dead after
	// `maxAttempts` claims. Returns false if the caller no longer holds it.
	const retry = async (token: string, id: string, { retryAt, maxAttempts }: RetryOptions) => {
		const rows = await db
			.update(outbox)
			.set({
				status: sql`case when ${outbox.attempts} >= ${maxAttempts} then 'dead' else 'pending' end`,
				available_at: retryAt.toISOString(),
				lease_token: null,
				lease_until: null,
			})
			.where(and(held(token), eq(outbox.id, id)))
			.returning({ id: outbox.id });
		return rows.length > 0;
	};

	return { claim, acknowledge, retry };
};

export type OutboxService = ReturnType<typeof createOutboxService>;
