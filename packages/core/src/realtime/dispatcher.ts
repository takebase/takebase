import type { ClaimedEvent, OutboxService } from "../services/outbox-d1-service.ts";
import type { RealtimeAdapter } from "./adapter.ts";
import { type Backoff, defaultBackoff, retryDelay } from "./retry.ts";

// Moves committed outbox events to the realtime adapter. It runs after a write
// commits and when a member opens a session; there is no cron. Each run claims
// batches until the outbox is empty or the time budget is spent, publishes one
// signal per collection (its highest revision) and acknowledges those events.
// A failed publish leaves its events in the outbox with a backoff; D1 data is
// never touched. A crash mid-run is recovered when the lease expires.

export type DispatchOptions = {
	outbox: OutboxService;
	adapter: RealtimeAdapter;
	now?: () => Date;
	batchSize?: number;
	leaseMs?: number;
	// Claims before an event is parked as dead.
	maxAttempts?: number;
	// Stop claiming new batches after this long; leftovers wait for the next run.
	budgetMs?: number;
	backoff?: Backoff;
};

export type DispatchResult = { delivered: number; failed: number };

const byCollection = (events: ClaimedEvent[]) => {
	const groups = new Map<string, ClaimedEvent[]>();
	for (const event of events) groups.set(event.collection, [...(groups.get(event.collection) ?? []), event]);
	return groups;
};

export const dispatchOutbox = async ({
	outbox,
	adapter,
	now = () => new Date(),
	batchSize = 50,
	leaseMs = 30_000,
	maxAttempts = 10,
	budgetMs = 10_000,
	backoff = defaultBackoff,
}: DispatchOptions): Promise<DispatchResult> => {
	const result: DispatchResult = { delivered: 0, failed: 0 };
	const deadline = now().getTime() + budgetMs;
	do {
		const { token, events } = await outbox.claim({ limit: batchSize, leaseMs, now: now() });
		if (events.length === 0) break;
		for (const [collection, group] of byCollection(events)) {
			const revision = Math.max(...group.map((event) => event.revision));
			try {
				await adapter.publish(collection, revision);
			} catch {
				for (const event of group) {
					const retryAt = new Date(now().getTime() + retryDelay(event.attempts, backoff));
					await outbox.retry(token, event.id, { retryAt, maxAttempts });
				}
				result.failed += group.length;
				continue;
			}
			const acknowledged = await outbox.acknowledge(
				token,
				group.map((event) => event.id),
				now(),
			);
			result.delivered += acknowledged.length;
		}
	} while (now().getTime() < deadline);
	return result;
};
