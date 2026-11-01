import { readFileSync } from "node:fs";
import { commandGroups, run } from "@takebase/cli";
import { describe, expect, it } from "vitest";

// R-7-3-01: every capability the project specification lists, checked against the
// real CLI's help and tied to the test or journey that drives it. A new capability
// without a driver must go in `blockingGaps`, never be left out silently. Agreed with
// the human (SEGU-230): `secrets revoke` is not a command, because `secrets rotate`
// retires a key, and `migrate` stays local, because deploy runs remote migrations.

type Capability = { group: string; documents: string; file: string; drives: string };

const capability = (group: string, documents: string, file: string, drives: string): Capability => ({
	group,
	documents,
	file,
	drives,
});

const journey = "tests/fixtures/cli-journey.ts";
const admin = "tests/fixtures/admin-journey.ts";
const backups = "tests/smoke/backups.sh";
const migrate = "tests/cli/collection-migrate.test.ts";
const secrets = "tests/smoke/secrets.sh";

const specified: Capability[] = [
	capability("init", "takebase init", "tests/cli/starter.test.ts", '"init"'),
	capability("create", "takebase create", "tests/cli/starter.test.ts", '"create"'),
	capability("dev", "takebase dev", "tests/smoke/lib.sh", 'pnpm "$script"'),
	capability("build", "takebase build", "tests/smoke/packaging.sh", "$CLI build"),
	capability("deploy", "takebase deploy", "tests/cli/deploy-plan.test.ts", "deployEnvironment(real.deps"),
	capability("deploy", "--tenant <id>", "tests/cli/deploy-plan.test.ts", 'tenant: "tenant-a"'),
	capability("doctor", "takebase doctor", journey, '"doctor"'),
	capability("user", "create --email", admin, '"user", "create"'),
	capability("user", "list", journey, '"user", "list"'),
	capability("user", "disable <uid>", admin, '"user", "disable"'),
	capability("user", "enable <uid>", admin, '"user", "enable"'),
	capability("user", "revoke-sessions <uid>", admin, '"user", "revoke-sessions"'),
	capability("user", "delete <uid>", journey, '"user", "delete"'),
	capability("tenant", "create <id>", "tests/fixtures/generated-starter.ts", "takebase tenant create acme"),
	capability("tenant", "provision <id>", journey, '"tenant", "provision"'),
	capability("tenant", "list", journey, '"tenant", "list"'),
	capability("tenant", "disable <id>", journey, '"tenant", "disable"'),
	capability("tenant", "delete <id>", journey, '"tenant", "delete"'),
	capability("tenant", "user add <id>", admin, '"tenant", "user", "add"'),
	capability("tenant", "user remove <id>", admin, '"tenant", "user", "remove"'),
	capability("tenant", "user list <id>", journey, '"tenant", "user", "list"'),
	capability("role", "list <tenant>", journey, '"role", "list"'),
	capability("role", "create <tenant>", journey, '"role", "create"'),
	capability("role", "delete <tenant>", journey, '"role", "delete"'),
	capability("role", "assign <tenant>", journey, '"role", "assign"'),
	capability("role", "unassign <tenant>", journey, '"role", "unassign"'),
	capability("invite", "create <tenant>", journey, '"invite", "create"'),
	capability("invite", "list <tenant>", journey, '"invite", "list"'),
	capability("invite", "revoke <tenant>", journey, '"invite", "revoke"'),
	capability("collection", "create <name>", migrate, '"collection",\n\t\t\t"create"'),
	capability("collection", "inspect <name>", migrate, '"collection", "inspect"'),
	capability("migrate", "generate --name", migrate, '"migrate", "generate"'),
	capability("migrate", "inspect [--sql]", migrate, '"migrate", "inspect"'),
	capability("migrate", "apply", migrate, '"migrate", "apply"'),
	capability("wire", "takebase wire status", "tests/fixtures/wire-journey.ts", '"wire", "status"'),
	capability("wire", "takebase wire test", "tests/fixtures/wire-journey.ts", '"wire", "test"'),
	capability("wire", "takebase wire retry", journey, '"wire", "retry"'),
	capability("secrets", "takebase secrets init", "tests/fixtures/secrets-journey.ts", '"secrets", "init"'),
	capability("secrets", "takebase secrets check", "tests/fixtures/secrets-journey.ts", '"secrets", "check"'),
	capability("secrets", "takebase secrets status", "tests/fixtures/secrets-journey.ts", '"secrets", "status"'),
	capability("secrets", "takebase secrets rotate", secrets, "$CLI secrets rotate"),
	capability("secrets", "takebase secrets recover", secrets, "$CLI secrets recover"),
	capability("backup", "takebase backup create", backups, "$CLI backup create"),
	capability("backup", "takebase backup list", backups, "$CLI backup list"),
	capability("backup", "--tenant <id>", "tests/cli/backup-verify.test.ts", "listBackups(b.store, { tenant })"),
	capability("backup", "takebase backup verify", backups, "$CLI backup verify"),
	capability("backup", "takebase backup restore", backups, "$CLI backup restore"),
	capability("backup", "takebase backup prune", backups, "$CLI backup prune"),
	capability("logs", "takebase logs", "tests/security/log-redaction.test.ts", "`takebase logs`"),
	capability("health", "takebase health", "tests/smoke/diagnostics.sh", "$CLI health"),
];

// Specified, implemented, but driven by nothing. Each would be a blocking gap.
const blockingGaps: Omit<Capability, "file" | "drives">[] = [];

const helpOf = async (group: string) => {
	let stdout = "";
	const code = await run([group, "--help"], {
		stdout: (text) => {
			stdout += text;
		},
		stderr: () => {},
		cwd: process.cwd(),
	});
	expect(code, group).toBe(0);
	return stdout;
};

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

describe("CLI coverage of the specification (R-7-3-01)", () => {
	it("covers exactly the CLI's command groups", () => {
		const covered = new Set(specified.map(({ group }) => group));
		expect(commandGroups.map(({ name }) => name).filter((name) => !covered.has(name))).toEqual([]);
		expect([...covered].filter((group) => !commandGroups.some(({ name }) => name === group))).toEqual([]);
	});

	it.each(specified)("$group documents `$documents`, driven by $file", async ({ group, documents, file, drives }) => {
		expect(await helpOf(group)).toContain(documents);
		expect(read(file)).toContain(drives);
	});

	it("names every capability no test drives yet", async () => {
		for (const { group, documents } of blockingGaps) expect(await helpOf(group)).toContain(documents);
		expect(blockingGaps).toEqual([]);
	});
});
