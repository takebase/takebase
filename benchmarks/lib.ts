// What every benchmark shares: a target that counts its requests, and a runner
// that reports one operation's latency distribution as the client saw it.

export type Target = {
	url: string;
	token: string;
	// Refuses to go past this many requests, so an approved limit cannot be exceeded.
	budget: number;
	sent: number;
};

export type Stats = {
	name: string;
	concurrency: number;
	count: number;
	errors: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
	perSecond: number;
};

export type Sizes = { concurrencies: number[]; crud: number; query: number; health: number };

export const send = (target: Target, path: string, init: RequestInit = {}, token: string | null = target.token) => {
	if (++target.sent > target.budget) throw new Error(`Stopped at the limit of ${target.budget} requests`);
	return fetch(`${target.url}${path}`, {
		...init,
		headers: {
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
			...(init.body === undefined ? {} : { "content-type": "application/json" }),
		},
	});
};

// The status alone, with the body read so the connection can be reused.
export const status = async (target: Target, path: string, init?: RequestInit, token?: string | null) => {
	const response = await send(target, path, init, token);
	await response.arrayBuffer();
	return response.status;
};

// Nearest rank over sorted values.
export const percentile = (sorted: number[], fraction: number) =>
	sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;

const rounded = (ms: number) => Math.round(ms * 10) / 10;

// Runs `count` calls of `operation` with `concurrency` in flight. A call that
// throws, or answers anything but `expected`, counts as an error, and its time
// is left out of the distribution.
export const measure = async (
	name: string,
	{ concurrency, count, expected }: { concurrency: number; count: number; expected: number },
	operation: (index: number) => Promise<number>,
): Promise<Stats> => {
	const samples: number[] = [];
	let errors = 0;
	let next = 0;
	const worker = async () => {
		while (next < count) {
			const index = next++;
			const started = performance.now();
			try {
				const answered = await operation(index);
				if (answered === expected) samples.push(performance.now() - started);
				else errors++;
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("Stopped at the limit")) throw error;
				errors++;
			}
		}
	};
	const started = performance.now();
	await Promise.all(Array.from({ length: concurrency }, worker));
	const elapsed = performance.now() - started;
	samples.sort((a, b) => a - b);
	return {
		name,
		concurrency,
		count,
		errors,
		p50: rounded(percentile(samples, 0.5)),
		p95: rounded(percentile(samples, 0.95)),
		p99: rounded(percentile(samples, 0.99)),
		max: rounded(samples.at(-1) ?? 0),
		perSecond: rounded((samples.length / elapsed) * 1000),
	};
};

export const table = (rows: Stats[]) =>
	[
		"| Operation | Concurrency | Requests | Errors | p50 ms | p95 ms | p99 ms | max ms | req/s |",
		"|---|---:|---:|---:|---:|---:|---:|---:|---:|",
		...rows.map(
			({ name, concurrency, count, errors, p50, p95, p99, max, perSecond }) =>
				`| ${name} | ${concurrency} | ${count} | ${errors} | ${p50} | ${p95} | ${p99} | ${max} | ${perSecond} |`,
		),
	].join("\n");
