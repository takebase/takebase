import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type EnvelopeStore,
	fullyRotated,
	progressFile,
	readProgress,
	rewriteSecrets,
	verifySecrets,
	writeProgress,
} from "../../packages/cli/src/services/key-rotation.ts";
import {
	importDataKey,
	openEnvelope,
	parseEnvelope,
	sealEnvelope,
} from "../../packages/cli/src/services/secret-envelopes.ts";
import type { SecretsKv } from "../../packages/core/src/index.ts";
import { memory, randomKey, randomValue, ring, scope, worker } from "../fixtures/secret-store.ts";

// Data key rotation (SEGU-224) against the tenant Worker's own secrets
// service: what core writes, the CLI re-encrypts, and core then reads with
// the new key alone. Keys and values are random per run: no credential-shaped
// literal is committed, and every assertion compares plaintext in memory.

// A tenant with secrets on V1 and V2: three written before V2 became active, two after.
const mixedTenant = async () => {
	const { map, kv, store } = memory();
	const keys = { 1: randomKey(), 2: randomKey() };
	const values: Record<string, string> = {};
	const v1 = worker(kv, { DATA_KEY_VERSION: "1", DATA_KEY_V1: keys[1] });
	for (const name of ["smtp", "stripe", "webhook"]) {
		values[name] = randomValue();
		await v1.put("app", name, values[name]);
	}
	const v2 = worker(kv, { DATA_KEY_VERSION: "2", DATA_KEY_V1: keys[1], DATA_KEY_V2: keys[2] });
	for (const name of ["s3", "sentry"]) {
		values[name] = randomValue();
		await v2.put("app", name, values[name]);
	}
	return { map, kv, store, keys, values };
};

// After rotation the Worker holds V2 only: every value must still read back.
const readsWithNewKeyOnly = async (kv: SecretsKv, key: string, values: Record<string, string>) => {
	const v2only = worker(kv, { DATA_KEY_VERSION: "2", DATA_KEY_V2: key });
	for (const [name, value] of Object.entries(values)) expect(await v2only.get("app", name), name).toBe(value);
};

let temp: string | undefined;
afterEach(() => {
	if (temp !== undefined) rmSync(temp, { recursive: true, force: true });
	temp = undefined;
});

describe("data key rotation", () => {
	it("the CLI's envelope code and the Worker's open each other's secrets", async () => {
		const { kv, map } = memory();
		const key = randomKey();
		const value = randomValue();
		await worker(kv, { DATA_KEY_VERSION: "1", DATA_KEY_V1: key }).put("app", "smtp", value);

		const stored = map.get("secret/app/smtp")?.value ?? "";
		const binding = { ...scope, keyVersion: 1, purpose: "app", name: "smtp" };
		const opened = await openEnvelope(await importDataKey(key), binding, parseEnvelope(stored));
		expect(Buffer.from(opened).toString("utf8")).toBe(value);

		const resealed = await sealEnvelope(await importDataKey(key), binding, Buffer.from(value, "utf8"));
		expect(resealed).not.toBe(stored);
		await kv.put("secret/app/smtp", resealed);
		expect(await worker(kv, { DATA_KEY_VERSION: "1", DATA_KEY_V1: key }).get("app", "smtp")).toBe(value);

		// The binding still holds: the same envelope under another name or tenant is refused.
		await expect(
			openEnvelope(await importDataKey(key), { ...binding, tenantId: "tenant-b" }, parseEnvelope(resealed)),
		).rejects.toThrow("could not be decrypted");
	});

	it("rotates mixed-version secrets fully, then the new key alone reads them all", async () => {
		const { kv, store, keys, values, map } = await mixedTenant();
		const before = await verifySecrets({ store, keys: ring(keys), scope, target: 2 });
		expect(before).toEqual({ total: 5, onTarget: 2, needs: { 1: 3 }, unreadable: 0, rejected: 0 });
		expect(fullyRotated(before)).toBe(false);

		const result = await rewriteSecrets({ store, keys: ring(keys), scope, target: 2, now: () => new Date(1) });
		expect(result).toEqual({ total: 5, onTarget: 2, rewritten: 3, changed: 0, unreadable: 0, remaining: 0 });
		for (const [name, { metadata }] of map) expect(metadata, name).toEqual(expect.objectContaining({ kv: 2 }));

		const after = await verifySecrets({ store, keys: ring({ 2: keys[2] }), scope, target: 2 });
		expect(fullyRotated(after)).toBe(true);
		await readsWithNewKeyOnly(kv, keys[2], values);
	});

	it("an interrupted rotation resumes without encrypting twice or losing a value", async () => {
		const { kv, store, keys, values } = await mixedTenant();
		const seals: string[] = [];
		let writes = 0;
		const crashing: EnvelopeStore = {
			...store,
			put: async (name, value, metadata) => {
				if (++writes > 1) throw new Error("interrupted");
				seals.push(name);
				await store.put(name, value, metadata);
			},
		};
		await expect(
			rewriteSecrets({ store: crashing, keys: ring(keys), scope, target: 2, now: () => new Date(1) }),
		).rejects.toThrow("interrupted");
		expect(fullyRotated(await verifySecrets({ store, keys: ring(keys), scope, target: 2 }))).toBe(false);

		// A bounded run, then the rest: the already rewritten secret is skipped each time.
		const recording: EnvelopeStore = {
			...store,
			put: async (name, value, metadata) => {
				seals.push(name);
				await store.put(name, value, metadata);
			},
		};
		const bounded = await rewriteSecrets({
			store: recording,
			keys: ring(keys),
			scope,
			target: 2,
			now: () => new Date(2),
			limit: 1,
		});
		expect(bounded).toEqual(expect.objectContaining({ onTarget: 3, rewritten: 1, remaining: 1 }));
		const rest = await rewriteSecrets({ store: recording, keys: ring(keys), scope, target: 2, now: () => new Date(3) });
		expect(rest).toEqual(expect.objectContaining({ onTarget: 4, rewritten: 1, remaining: 0 }));
		expect(seals).toHaveLength(3);
		expect(new Set(seals).size).toBe(3);

		// A value changed between the read and the write keeps the newer write.
		const { kv: raceKv, store: raceStore, keys: raceKeys } = await mixedTenant();
		const newer = randomValue();
		const racing: EnvelopeStore = {
			...raceStore,
			get: async (name) => {
				const current = await raceStore.get(name);
				if (name === "secret/app/smtp" && JSON.parse(current ?? "{}").kv === 1) {
					await worker(raceKv, { DATA_KEY_VERSION: "2", DATA_KEY_V1: raceKeys[1], DATA_KEY_V2: raceKeys[2] }).put(
						"app",
						"smtp",
						newer,
					);
				}
				return current;
			},
		};
		const raced = await rewriteSecrets({
			store: racing,
			keys: ring(raceKeys),
			scope,
			target: 2,
			now: () => new Date(4),
		});
		expect(raced.changed).toBe(1);
		expect(await worker(raceKv, { DATA_KEY_VERSION: "2", DATA_KEY_V2: raceKeys[2] }).get("app", "smtp")).toBe(newer);

		await readsWithNewKeyOnly(kv, keys[2], values);
	});

	it("unreadable secrets block retirement, and no key or value reaches progress, results or KV", async () => {
		const { map, store, keys, values } = await mixedTenant();
		map.set("secret/app/broken", { value: "{not an envelope" });
		map.set("secret/app/foreign", { value: map.get("secret/app/smtp")?.value ?? "" });

		const result = await rewriteSecrets({ store, keys: ring(keys), scope, target: 2, now: () => new Date(1) });
		expect(result.unreadable).toBe(2);
		const verified = await verifySecrets({ store, keys: ring(keys), scope, target: 2 });
		expect(fullyRotated(verified)).toBe(false);

		temp = mkdtempSync(join(tmpdir(), "takebase-rotation-"));
		const path = progressFile(join(temp, "keys.env"), "local", "tenant-a");
		writeProgress(path, {
			tenant: "tenant-a",
			environment: "local",
			from: 1,
			to: 2,
			phase: "rewritten",
			started: new Date(0).toISOString(),
			updated: new Date(1).toISOString(),
			rewrittenAt: new Date(1).toISOString(),
			verifiedAt: null,
			counts: {
				total: result.total,
				onTarget: result.onTarget,
				rewritten: result.rewritten,
				unreadable: result.unreadable,
			},
		});
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readProgress(path, "tenant-a", "local")?.phase).toBe("rewritten");
		expect(() => readProgress(path, "tenant-b", "local")).toThrow("not a rotation record");

		const kvText = [...map].map(([name, entry]) => `${name}${entry.value}${JSON.stringify(entry.metadata)}`).join("\n");
		const written = [readFileSync(path, "utf8"), JSON.stringify(result), JSON.stringify(verified), kvText].join("\n");
		for (const secret of [...Object.values(keys), ...Object.values(values)]) {
			expect(written.includes(secret)).toBe(false);
			expect(written.includes(Buffer.from(secret, "utf8").toString("base64url"))).toBe(false);
		}
	});
});
