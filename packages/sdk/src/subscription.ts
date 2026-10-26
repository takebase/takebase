// What a subscriber learns: `collection` changed up to `revision`. Signals carry
// no records; the subscriber refetches through the API, where the collection
// rules decide what it may see. `revision` is 0 when nothing was published yet.
export type RealtimeEvent = { collection: string; revision: number };

export type SubscriptionCallback = (event: RealtimeEvent) => void;

// One subscriber's view of a collection's revisions. Repeated and older
// revisions are dropped, and a burst within `delayMs` becomes one call with the
// newest revision. A catch-up (a new subscription or connection) always calls,
// so a signal missed while offline cannot hide committed changes.
export const createSubscription = (collection: string, callback: SubscriptionCallback, delayMs: number) => {
	let latest = 0;
	let pending = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const flush = () => {
		timer = undefined;
		if (!pending) return;
		pending = false;
		try {
			callback({ collection, revision: latest });
		} catch (error) {
			console.error("Realtime subscriber failed", error);
		}
	};

	const deliver = (revision: number, catchUp: boolean) => {
		if (!catchUp && revision <= latest) return;
		latest = Math.max(latest, revision);
		pending = true;
		timer ??= setTimeout(flush, delayMs);
	};

	const cancel = () => {
		clearTimeout(timer);
		timer = undefined;
		pending = false;
	};

	return { deliver, cancel };
};
