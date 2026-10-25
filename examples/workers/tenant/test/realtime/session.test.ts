import type { ErrorEnvelope, RealtimeSession } from "@takebase/contracts";
import { createRealtimeRoutes, type RealtimeRequest } from "@takebase/core";
import { describe, expect, it } from "vitest";
import { internalIdentity } from "../fixtures.ts";
import { fakeAdapter } from "./fake-adapter.ts";

const url = "https://tenant.local/api/realtime/session";
const member = { ...internalIdentity, id: "user-1" };

const open = async (request: Partial<RealtimeRequest>) => {
	const response = await createRealtimeRoutes({
		resolve: () => ({ auth: null, accessRevision: null, adapter: null, ...request }),
	}).request(url, { method: "POST" });
	return { status: response.status, body: (await response.json()) as RealtimeSession & ErrorEnvelope };
};

describe("POST /api/realtime/session", () => {
	it("grants a verified member at the access revision of their membership check", async () => {
		const fake = fakeAdapter();
		let flushed = 0;
		const { status, body } = await open({
			auth: member,
			accessRevision: 57,
			adapter: fake.adapter,
			granted: () => flushed++,
		});
		expect(status).toBe(200);
		expect(body).toEqual({ uid: "user-1", revision: 57, connection: { kind: "fake" } });
		expect(fake.calls).toEqual([{ op: "grant", args: ["user-1", 57] }]);
		expect(flushed).toBe(1);
	});

	it("never grants anonymous callers", async () => {
		const fake = fakeAdapter();
		const { status, body } = await open({ adapter: fake.adapter, accessRevision: 57 });
		expect([status, body.error.code]).toEqual([401, "unauthenticated"]);
		expect(fake.calls).toEqual([]);
	});

	it("answers 503 without realtime, without a revision, or when the grant fails", async () => {
		const fake = fakeAdapter();
		let flushed = 0;
		const granted = () => flushed++;
		expect((await open({ auth: member, accessRevision: 57, adapter: null })).status).toBe(503);
		expect((await open({ auth: member, accessRevision: null, adapter: fake.adapter })).status).toBe(503);
		fake.failNext(1);
		const failed = await open({ auth: member, accessRevision: 57, adapter: fake.adapter, granted });
		expect([failed.status, failed.body.error.code]).toEqual([503, "unavailable"]);
		expect(flushed).toBe(0);
	});
});
