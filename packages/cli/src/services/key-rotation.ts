import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "../errors.ts";
import {
	type DataKey,
	EnvelopeError,
	openEnvelope,
	type ParsedEnvelope,
	parseEnvelope,
	sealEnvelope,
} from "./secret-envelopes.ts";

// Data key rotation (SEGU-224), on any store of a tenant's encrypted secrets:
// re-encrypt every secret still on an older key with the active one, then
// verify every secret opens with it before the old key may be removed.
//
// Re-encryption is idempotent: a secret already on the target version is
// skipped, so a rerun after an interruption continues without encrypting
// anything twice. KV has no transactions or compare-and-swap; each secret is
// read again just before it is written and skipped when it changed meanwhile,
// which narrows a concurrent writer's window but cannot close it. A writer
// still on the old key could lose an update in that window, never make a
// secret undecryptable: rotation runs only after the new key is active.
//
// Plaintext exists only in this process's memory for one secret at a time and
// is zeroed after use. Results and progress hold counts, versions and times.

export type EnvelopeStore = {
	// Every KV key under `secret/` (names, never values).
	names: () => Promise<string[]>;
	get: (name: string) => Promise<string | null>;
	put: (name: string, value: string, metadata: { kv: number; updated: string }) => Promise<void>;
};

// The imported key for a version; throws a CliError when it is not available.
export type KeyRing = (version: number) => Promise<DataKey>;

export type RotationScope = { tenantId: string; environment: string };

const prefix = "secret/";

const partsOf = (key: string) => {
	const [purpose, name, ...rest] = key.slice(prefix.length).split("/");
	if (!key.startsWith(prefix) || !purpose || !name || rest.length > 0) return null;
	return { purpose, name };
};

const parsed = (stored: string): ParsedEnvelope | null => {
	try {
		return parseEnvelope(stored);
	} catch (error) {
		if (error instanceof EnvelopeError) return null;
		throw error;
	}
};

export type RewriteResult = {
	total: number;
	// Already on the target version before this run.
	onTarget: number;
	rewritten: number;
	// Changed or deleted between this run's read and its write: left as written.
	changed: number;
	// Not a valid envelope, under no available key, or tampered.
	unreadable: number;
	// Left for a later run by `limit`.
	remaining: number;
};

export const rewriteSecrets = async ({
	store,
	keys,
	scope,
	target,
	now,
	limit = Number.POSITIVE_INFINITY,
}: {
	store: EnvelopeStore;
	keys: KeyRing;
	scope: RotationScope;
	target: number;
	now: () => Date;
	limit?: number;
}): Promise<RewriteResult> => {
	const targetKey = await keys(target);
	const result: RewriteResult = { total: 0, onTarget: 0, rewritten: 0, changed: 0, unreadable: 0, remaining: 0 };
	for (const key of await store.names()) {
		result.total++;
		const parts = partsOf(key);
		const stored = parts === null ? null : await store.get(key);
		if (parts === null || stored === null) {
			// A listed key whose value cannot be read yet (KV is eventually consistent) counts as changed.
			if (parts === null) result.unreadable++;
			else result.changed++;
			continue;
		}
		const envelope = parsed(stored);
		if (envelope === null) {
			result.unreadable++;
			continue;
		}
		if (envelope.keyVersion === target) {
			result.onTarget++;
			continue;
		}
		if (envelope.keyVersion > target) {
			throw new CliError(
				`A secret of tenant ${scope.tenantId} uses key v${envelope.keyVersion}, newer than v${target}`,
				{
					hint: "Another rotation already ran; check `takebase secrets status`. Nothing more was changed.",
				},
			);
		}
		if (result.rewritten >= limit) {
			result.remaining++;
			continue;
		}
		let plaintext: Uint8Array;
		try {
			const oldKey = await keys(envelope.keyVersion);
			plaintext = await openEnvelope(oldKey, { ...scope, ...parts, keyVersion: envelope.keyVersion }, envelope);
		} catch (error) {
			if (!(error instanceof EnvelopeError || error instanceof CliError)) throw error;
			result.unreadable++;
			continue;
		}
		let sealed: string;
		try {
			sealed = await sealEnvelope(targetKey, { ...scope, ...parts, keyVersion: target }, plaintext);
		} finally {
			plaintext.fill(0);
		}
		if ((await store.get(key)) !== stored) {
			result.changed++;
			continue;
		}
		await store.put(key, sealed, { kv: target, updated: now().toISOString() });
		result.rewritten++;
	}
	return result;
};

export type VerifyResult = {
	total: number;
	// Opens with the target key.
	onTarget: number;
	// Secrets still on another version, by version.
	needs: Record<number, number>;
	// Not a valid envelope, or on the target version but not opened by its key.
	unreadable: number;
	// The part of `unreadable` on the target version: the key does not open them.
	rejected: number;
};

// True when no secret needs any key but the target.
export const fullyRotated = (result: VerifyResult) =>
	result.unreadable === 0 && Object.keys(result.needs).length === 0 && result.onTarget === result.total;

// Opens every secret on the target version with its key and counts the
// secrets still on other versions: proves which keys are still needed.
// Nothing is written.
export const verifySecrets = async ({
	store,
	keys,
	scope,
	target,
}: {
	store: EnvelopeStore;
	keys: KeyRing;
	scope: RotationScope;
	target: number;
}): Promise<VerifyResult> => {
	const result: VerifyResult = { total: 0, onTarget: 0, needs: {}, unreadable: 0, rejected: 0 };
	for (const key of await store.names()) {
		result.total++;
		const parts = partsOf(key);
		const stored = parts === null ? null : await store.get(key);
		const envelope = stored === null ? null : parsed(stored);
		if (parts === null || envelope === null) {
			result.unreadable++;
			continue;
		}
		if (envelope.keyVersion !== target) {
			result.needs[envelope.keyVersion] = (result.needs[envelope.keyVersion] ?? 0) + 1;
			continue;
		}
		try {
			const plaintext = await openEnvelope(await keys(target), { ...scope, ...parts, keyVersion: target }, envelope);
			plaintext.fill(0);
			result.onTarget++;
		} catch (error) {
			if (!(error instanceof EnvelopeError || error instanceof CliError)) throw error;
			result.unreadable++;
			result.rejected++;
		}
	}
	return result;
};

// One tenant's rotation, recorded between runs so an interrupted rotation
// continues where it stopped. Versions, counts and times only: never a key,
// a secret's name or its value. A tenant keeps one installed key; `from`
// exists only until `retired`.
// - installed: the new key is escrowed and installed beside the old one;
// - activated: new secrets are written with it (DATA_KEY_VERSION = `to`);
// - rewritten: every readable secret was re-encrypted with it;
// - verified: every secret opens with it, checked after the settle window;
// - retired: the old key is removed from the Worker.
export type RotationPhase = "installed" | "activated" | "rewritten" | "verified" | "retired";

export type RotationProgress = {
	tenant: string;
	environment: string;
	from: number;
	to: number;
	phase: RotationPhase;
	started: string;
	updated: string;
	// When the last re-encryption ran; verification starts at least the settle window later.
	rewrittenAt: string | null;
	verifiedAt: string | null;
	counts: { total: number; onTarget: number; rewritten: number; unreadable: number };
};

// Beside the keys file, untracked: <keys file dir>/.rotation/<environment>-<tenant>.json.
export const progressFile = (keysFile: string, environment: string, tenantId: string) =>
	join(dirname(keysFile), ".rotation", `${environment}-${tenantId}.json`);

const phases: readonly RotationPhase[] = ["installed", "activated", "rewritten", "verified", "retired"];

// The recorded rotation of this tenant and environment, or null. A file that
// is not one (corrupt, edited, or another tenant's) is refused, not trusted.
export const readProgress = (path: string, tenantId: string, environment: string): RotationProgress | null => {
	if (!existsSync(path)) return null;
	let value: Partial<RotationProgress> | null = null;
	try {
		value = JSON.parse(readFileSync(path, "utf8")) as Partial<RotationProgress>;
	} catch {}
	const valid =
		value !== null &&
		typeof value === "object" &&
		value.tenant === tenantId &&
		value.environment === environment &&
		Number.isSafeInteger(value.from) &&
		(value.from ?? 0) >= 1 &&
		value.to === (value.from ?? 0) + 1 &&
		phases.includes(value.phase as RotationPhase) &&
		typeof value.counts === "object" &&
		value.counts !== null;
	if (!valid) {
		throw new CliError(`${path} is not a rotation record of tenant ${tenantId} (${environment})`, {
			hint: "Check or remove it by hand: rotation never guesses its phase. Nothing was changed.",
		});
	}
	return value as RotationProgress;
};

export const writeProgress = (path: string, progress: RotationProgress) => {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(progress, null, "\t")}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
};
