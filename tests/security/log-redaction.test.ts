import { afterEach, describe, expect, it, vi } from "vitest";
import { redact as cliRedact } from "../../packages/cli/src/services/redact.ts";
import { createTailParser, formatTailEvent } from "../../packages/cli/src/services/tail.ts";
import { createLogger, redact, requestIdOf } from "../../packages/core/src/diagnostics/log.ts";

// Secret, token and PII fixtures that must never reach a log line. The
// JWT-shaped and API-key-shaped values are fake and assembled at runtime, so
// secret scanners never see a credential-shaped literal in this file.
const jwt = ["eyJhbGciOiJub25lIn0", "eyJmaXh0dXJlIjoxfQ", "ZmFrZS1zaWduYXR1cmU"].join(".");
const password = "hunter2-dispatcher-password";
const apiKey = ["AIza", "Sy", "FakeFixtureOnly", "0123456789"].join("");
const refresh = "AMf-vBrefresh-token-fixture";
const email = "alice@example.test";
const secrets = [jwt, password, apiKey, refresh, email, "ZmFrZS1zaWduYXR1cmU"];

const captureLines = () => {
	const lines: string[] = [];
	for (const level of ["log", "warn", "error"] as const) {
		vi.spyOn(console, level).mockImplementation((line: unknown) => {
			lines.push(String(line));
		});
	}
	return lines;
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("redacted logging", () => {
	it("never writes secrets, tokens or emails, whatever the caller passes", () => {
		const lines = captureLines();
		const log = createLogger({ service: "tenant", tenantId: "tenant-a", requestId: "req-12345678" });
		const error = new Error(
			`fetch https://db.firebaseio.com/x.json?auth=${jwt}&print=silent failed for ${email}: Bearer ${jwt}`,
		);
		error.stack = `Error: at secret ${password}`;

		log.error("realtime.dispatch_failed", {
			error,
			password,
			FIREBASE_API_KEY: apiKey,
			headers: { Authorization: `Bearer ${jwt}`, "x-other": "kept" },
			nested: { deeper: { refreshToken: refresh, list: [`token=${refresh}`, `?apiKey=${apiKey}`] } },
			note: `signed in as ${email} with ${jwt}`,
			long: "x".repeat(5000),
			// Fields can never overwrite who wrote the line.
			service: "forged",
			requestId: "forged",
			level: "info",
		});
		log.warn("Not An Event\nforged", { body: { password } });
		log.info("outbox.retry", { actor: "firebase:uid-1", count: 2 });

		const output = lines.join("\n");
		for (const secret of secrets) expect(output).not.toContain(secret);
		expect(output).not.toContain("at secret");

		const [failure, invalid, retry] = lines.map((line) => JSON.parse(line));
		expect(failure).toMatchObject({
			level: "error",
			event: "realtime.dispatch_failed",
			service: "tenant",
			tenantId: "tenant-a",
			requestId: "req-12345678",
			password: "[redacted]",
			FIREBASE_API_KEY: "[redacted]",
			headers: { Authorization: "[redacted]", "x-other": "kept" },
		});
		expect(failure.error).toEqual({ name: "Error", message: expect.stringContaining("[redacted]") });
		expect(failure.long.length).toBeLessThanOrEqual(501);
		expect(invalid.event).toBe("invalid_event");
		expect(retry).toMatchObject({ level: "info", event: "outbox.retry", actor: "firebase:uid-1", count: 2 });
	});

	it("`takebase logs` prints wrangler tail events redacted, with the CLI's copy matching the Workers'", () => {
		const fixture = {
			note: `Bearer ${jwt} ${email} ?auth=${jwt} password=${password}`,
			password,
			nested: { apiKey, list: [refresh, { refreshToken: refresh }] },
			long: "y".repeat(2000),
		};
		expect(cliRedact(fixture)).toEqual(redact(fixture));

		const event = {
			outcome: "exception",
			scriptName: "takebase-staging-tenant-a",
			eventTimestamp: 1793112000000,
			event: {
				request: {
					url: `https://tenant.example/api/collections/policies/records?auth=${jwt}&filter=${email}`,
					method: "POST",
					headers: { authorization: `Bearer ${jwt}`, cookie: `session=${refresh}` },
				},
				response: { status: 500 },
			},
			logs: [
				{
					level: "error",
					message: [
						JSON.stringify({
							level: "error",
							event: "realtime.dispatch_failed",
							service: "tenant",
							requestId: "req-abcdef12",
							error: { name: "Error", message: `sign-in as ${email} failed` },
						}),
					],
				},
				{ level: "log", message: ["raw console line", { password, idToken: jwt }, `key=${apiKey}`] },
			],
			exceptions: [{ name: "Error", message: `boom ${password} Bearer ${jwt}` }],
		};
		const lines: string[] = [];
		// The environment's secrets file supplies values no pattern can recognise.
		const parse = createTailParser((parsed) => lines.push(...formatTailEvent(parsed, [password, apiKey])));
		// Wrangler pretty-prints each event and may split it across chunks.
		const printed = `Successfully created tail\n${JSON.stringify(event, null, 2)}\n`;
		parse(printed.slice(0, 333));
		parse(printed.slice(333));

		const output = lines.join("\n");
		for (const secret of [...secrets, password]) expect(output).not.toContain(secret);
		expect(output).not.toContain("filter=");
		expect(lines[0]).toBe("2026-10-27T14:40:00.000Z exception POST /api/collections/policies/records 500 req-abcdef12");
		expect(lines[1]).toContain("error realtime.dispatch_failed");
		expect(lines.at(-1)).toContain("exception Error: boom");
	});

	it("accepts only a bounded, well-formed correlation id", () => {
		const request = (headers: Record<string, string>) => new Request("https://t.example/", { headers });
		const uuid = /^[0-9a-f-]{36}$/;

		expect(requestIdOf(request({ "x-request-id": "client-req-0001" }))).toBe("client-req-0001");
		expect(requestIdOf(request({ "cf-ray": "8a1b2c3d4e5f6789-LAX" }))).toBe("8a1b2c3d4e5f6789-LAX");
		for (const forged of ["short", "a".repeat(65), "<script>x</script>", "has spaces 12345", '{"json":1}xx']) {
			expect(requestIdOf(request({ "x-request-id": forged }))).toMatch(uuid);
		}
		expect(requestIdOf()).toMatch(uuid);
	});
});
