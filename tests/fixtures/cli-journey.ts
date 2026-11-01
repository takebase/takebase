import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// R-7-3-01: the real `takebase` commands no other journey drives, against the
// local stack (`pnpm dev:stack`). The services behind them have their invariants
// tested in tests/operations; this proves the commands reach them. Emulators and
// local D1 only. It leaves tenant-b provisioned again and prints no invitation token.
//
//   node tests/fixtures/cli-journey.ts

const root = new URL("../../", import.meta.url).pathname;
const bin = join(root, "packages/cli/src/bin.ts");

let failures = 0;
const expect = (label: string, ok: boolean, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${detail}`}`);
};

// `takebase dev` sets these for what it runs; a separate command names the running emulators itself.
const emulators = {
	FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
	FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9000",
};

const cli = (...args: string[]) => {
	const result = spawnSync(process.execPath, [bin, ...args], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, ...emulators },
	});
	return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
};

const succeeds = (label: string, args: string[], text = "") => {
	const { status, output } = cli(...args);
	expect(label, status === 0 && output.includes(text), status === 0 ? "" : `exit ${status}`);
	return output;
};

const refused = (label: string, args: string[]) => expect(label, cli(...args).status !== 0);

const rowWith = (output: string, text: string) => output.split("\n").find((line) => line.includes(text)) ?? "";

const temp = mkdtempSync(join(tmpdir(), "takebase-cli-journey-"));
try {
	succeeds("doctor", ["doctor"], "0 failed");

	const created = succeeds("user create", [
		"user",
		"create",
		"--email",
		`cli-journey-${Date.now()}@example.test`,
		"--password-file",
		join(temp, "password"),
	]);
	const uid = /[A-Za-z0-9]{20,}/.exec(created)?.[0] ?? "";
	expect("user create prints the uid", uid !== "");
	expect("user list shows them", rowWith(succeeds("user list", ["user", "list"]), uid).includes("active"));

	const role = `journey${Date.now()}`;
	succeeds("role create", ["role", "create", "tenant-a", role]);
	expect("role list shows it", rowWith(succeeds("role list", ["role", "list", "tenant-a"]), role) !== "");
	succeeds("role assign", ["role", "assign", "tenant-a", uid, role]);
	expect(
		"tenant user list shows the role",
		rowWith(succeeds("tenant user list", ["tenant", "user", "list", "tenant-a"]), uid).includes(role),
	);
	refused("role delete refuses a role in use", ["role", "delete", "tenant-a", role]);
	succeeds("role unassign", ["role", "unassign", "tenant-a", uid, role]);
	succeeds("role delete", ["role", "delete", "tenant-a", role]);
	refused("role delete refuses admin", ["role", "delete", "tenant-a", "admin"]);

	succeeds("invite create", ["invite", "create", "tenant-a", "--role", "agent", "--expires", "72h"]);
	const pending = rowWith(succeeds("invite list", ["invite", "list", "tenant-a"]), "pending");
	const invite = /^\s*([0-9a-f-]{36})/.exec(pending)?.[1] ?? "";
	expect("invite list shows it pending", invite !== "");
	succeeds("invite revoke", ["invite", "revoke", "tenant-a", invite]);
	expect("invite list shows it revoked", rowWith(cli("invite", "list", "tenant-a").output, invite).includes("revoked"));

	refused("user delete needs --confirm", ["user", "delete", uid]);
	succeeds("user delete", ["user", "delete", uid, "--confirm", uid]);

	succeeds("wire retry", ["wire", "retry", "tenant-a", "--dead"], "Revived");

	expect(
		"tenant list shows it active",
		rowWith(succeeds("tenant list", ["tenant", "list"]), "tenant-b").includes("active"),
	);
	refused("tenant delete refuses an active tenant", ["tenant", "delete", "tenant-b", "--confirm", "tenant-b"]);
	succeeds("tenant disable", ["tenant", "disable", "tenant-b"]);
	expect("tenant list shows it disabled", rowWith(cli("tenant", "list").output, "tenant-b").includes("disabled"));
	succeeds("tenant delete", ["tenant", "delete", "tenant-b", "--confirm", "tenant-b"]);
	succeeds("tenant provision", ["tenant", "provision", "tenant-b"]);
	expect("tenant list shows it active again", rowWith(cli("tenant", "list").output, "tenant-b").includes("active"));
} finally {
	rmSync(temp, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`${failures} CLI journey check(s) failed.`);
	process.exit(1);
}
console.log("All R-7-3-01 CLI journey checks passed.");
