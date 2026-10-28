import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { directoryEscrow, keysFileEscrow, recoverKey } from "../../packages/cli/src/services/key-escrow.ts";
import { memory, randomKey, randomValue, scope, worker } from "../fixtures/secret-store.ts";

// Lost-key recovery (SEGU-224, S-6-2-01): a tenant's key is deposited in the
// keys file and in a separate escrow (the directory escrow simulates an
// external key manager), the keys file is lost, and the key is restored from
// the escrow only after it is proven to open the tenant's secrets. Plaintext
// is compared in memory only.

let temp: string;
beforeEach(() => {
	temp = mkdtempSync(join(tmpdir(), "takebase-recovery-"));
});
afterEach(() => {
	rmSync(temp, { recursive: true, force: true });
});

const entry = { tenantId: scope.tenantId, version: 1 };

// A tenant whose V1 key was escrowed at init, with secrets written under it.
const escrowedTenant = async () => {
	const { kv, store, map } = memory();
	const key = randomKey();
	const keysFile = join(temp, "keys.env");
	const escrow = directoryEscrow(join(temp, "escrow"), scope.environment);
	await escrow.deposit(entry, key);
	await keysFileEscrow(keysFile).deposit(entry, key);
	const values: Record<string, string> = {};
	const service = worker(kv, { DATA_KEY_VERSION: "1", DATA_KEY_V1: key });
	for (const name of ["smtp", "stripe", "webhook"]) {
		values[name] = randomValue();
		await service.put("app", name, values[name]);
	}
	return { kv, store, map, key, keysFile, escrow, values };
};

describe("lost-key recovery from escrow", () => {
	it("restores a lost key from the escrow, and every value reads back", async () => {
		const { kv, store, key, keysFile, escrow, values } = await escrowedTenant();
		const dir = join(temp, "escrow");
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		for (const file of readdirSync(dir)) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
		await expect(escrow.deposit(entry, randomKey())).rejects.toThrow("already holds");

		rmSync(keysFile);
		const recovery = await recoverKey({ escrow, keysFile, store, scope, version: 1 });
		expect(recovery).toEqual({ tenantId: "tenant-a", version: 1, outcome: "restored", opened: 3 });
		expect(statSync(keysFile).mode & 0o777).toBe(0o600);

		const restored = (await keysFileEscrow(keysFile).withdraw(entry)) ?? "";
		expect(restored === key).toBe(true);
		const service = worker(kv, { DATA_KEY_VERSION: "1", DATA_KEY_V1: restored });
		for (const [name, value] of Object.entries(values))
			expect((await service.get("app", name)) === value, name).toBe(true);

		// Run again: the key is present, nothing is restored twice.
		expect((await recoverKey({ escrow, keysFile, store, scope, version: 1 })).outcome).toBe("present");
		expect(readFileSync(keysFile, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
	});

	it("refuses an escrowed key that does not open the secrets, or a missing one, and writes nothing", async () => {
		const { store, keysFile } = await escrowedTenant();
		rmSync(keysFile);

		const wrong = directoryEscrow(join(temp, "wrong"), scope.environment);
		await wrong.deposit(entry, randomKey());
		await expect(recoverKey({ escrow: wrong, keysFile, store, scope, version: 1 })).rejects.toThrow(
			"does not open 3 secret(s)",
		);
		const empty = directoryEscrow(join(temp, "empty"), scope.environment);
		await expect(recoverKey({ escrow: empty, keysFile, store, scope, version: 1 })).rejects.toThrow("has no");
		expect(existsSync(keysFile)).toBe(false);
	});

	it("no key or value reaches the recovery result, errors or KV", async () => {
		const { store, map, key, keysFile, escrow, values } = await escrowedTenant();
		rmSync(keysFile);
		const outputs = [JSON.stringify(await recoverKey({ escrow, keysFile, store, scope, version: 1 }))];
		const wrong = directoryEscrow(join(temp, "wrong"), scope.environment);
		await wrong.deposit(entry, randomKey());
		const wrongKey = (await wrong.withdraw(entry)) ?? "";
		rmSync(keysFile);
		outputs.push(
			await recoverKey({ escrow: wrong, keysFile, store, scope, version: 1 }).then(
				() => "",
				(error: Error) => `${error.message}\n${(error as { hint?: string }).hint ?? ""}`,
			),
		);
		outputs.push(
			[...map].map(([name, stored]) => `${name}${stored.value}${JSON.stringify(stored.metadata)}`).join("\n"),
		);
		const text = outputs.join("\n");
		for (const secret of [key, wrongKey, ...Object.values(values)]) expect(text.includes(secret)).toBe(false);
	});
});
