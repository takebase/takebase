import { percentile, send, type Target } from "./lib.ts";

// How long a committed write takes to reach the realtime database, and how fast
// one delivery run drains a backlog. The first reads the database as a member
// would; the second injects its backlog with SQL, so it runs locally only.

export type SignalLatency = { samples: number; timeouts: number; p50: number; max: number };
export type DrainResult = { events: number; delivered: number; ms: number; perSecond: number };

const records = "/api/collections/policies/records";
const timeoutMs = 10_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const signalLatency = async (
	target: Target,
	revisionUrl: string,
	samples: number,
	run: string,
): Promise<SignalLatency> => {
	const session = await send(target, "/api/realtime/session", { method: "POST" });
	await session.arrayBuffer();
	if (session.status !== 200) throw new Error(`Opening realtime answered HTTP ${session.status}`);
	const revision = async () => {
		const response = await fetch(revisionUrl);
		if (!response.ok) throw new Error(`Reading the signal answered HTTP ${response.status}`);
		const body = (await response.json()) as { revision?: number } | null;
		return body?.revision ?? 0;
	};
	const times: number[] = [];
	let timeouts = 0;
	for (let index = 0; index < samples; index++) {
		const before = await revision();
		const started = performance.now();
		const created = await send(target, records, {
			method: "POST",
			body: JSON.stringify({ number: `BENCH-${run}-signal-${index}`, holder: "Benchmark Holder", status: "pending" }),
		});
		await created.arrayBuffer();
		if (created.status !== 201) throw new Error(`Creating a policy answered HTTP ${created.status}`);
		let seen = false;
		while (!seen && performance.now() - started < timeoutMs) {
			seen = (await revision()) > before;
			if (!seen) await wait(20);
		}
		if (seen) times.push(performance.now() - started);
		else timeouts++;
	}
	times.sort((a, b) => a - b);
	return {
		samples,
		timeouts,
		p50: Math.round(percentile(times, 0.5)),
		max: Math.round(times.at(-1) ?? 0),
	};
};

// `sql` runs one statement on the tenant's local D1.
export const outboxDrain = async (
	target: Target,
	sql: (statement: string) => Record<string, unknown>[],
	events: number,
	run: string,
): Promise<DrainResult> => {
	const now = new Date().toISOString();
	sql(
		`with recursive n(i) as (select 1 union all select i + 1 from n where i < ${events}) insert into takebase_outbox (id, collection, operation, record_id, created, status, attempts, available_at) select 'bench-${run}-' || i, 'policies', 'update', 'bench', '${now}', 'pending', 0, '${now}' from n`,
	);
	const started = performance.now();
	const response = await send(target, "/api/realtime/dispatch", { method: "POST" }, null);
	await response.arrayBuffer();
	const ms = performance.now() - started;
	if (response.status !== 200) throw new Error(`Dispatch answered HTTP ${response.status}`);
	const [row] = sql(
		`select count(*) as delivered from takebase_outbox where id like 'bench-${run}-%' and status = 'delivered'`,
	);
	const delivered = Number(row?.delivered ?? 0);
	return { events, delivered, ms: Math.round(ms), perSecond: Math.round((delivered / ms) * 1000) };
};
