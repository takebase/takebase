// Exponential backoff for failed deliveries: 1 s, 2 s, 4 s … capped at 5 minutes.
// `attempts` is the number of claims so far, so the first retry waits `baseMs`.
export type Backoff = { baseMs: number; maxMs: number };

export const defaultBackoff: Backoff = Object.freeze({ baseMs: 1_000, maxMs: 5 * 60_000 });

export const retryDelay = (attempts: number, { baseMs, maxMs }: Backoff = defaultBackoff) =>
	Math.min(baseMs * 2 ** Math.max(0, attempts - 1), maxMs);
