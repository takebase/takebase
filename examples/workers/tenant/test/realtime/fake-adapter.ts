import type { RealtimeAdapter } from "@takebase/core";

// A RealtimeAdapter that implements only the contract, recording every call.
// `failNext(n)` makes the next n calls throw, standing in for a timeout, a 429
// or a 5xx from the realtime service.
export const fakeAdapter = () => {
	const calls: { op: string; args: unknown[] }[] = [];
	let failures = 0;
	const record =
		(op: string) =>
		async (...args: unknown[]) => {
			calls.push({ op, args });
			if (failures > 0) {
				failures--;
				throw new Error(`${op} failed`);
			}
		};
	const adapter: RealtimeAdapter = {
		publish: record("publish"),
		grant: record("grant"),
		revoke: record("revoke"),
		revokeAll: record("revokeAll"),
		connection: Object.freeze({ kind: "fake" }),
	};
	return {
		adapter,
		calls,
		published: () => calls.filter((call) => call.op === "publish").map((call) => call.args),
		failNext: (count: number) => {
			failures = count;
		},
	};
};
