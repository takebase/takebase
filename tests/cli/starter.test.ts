import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandGroups, run } from "@takebase/cli";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../../packages/cli/src/bin.ts", import.meta.url));

const starterFiles = [
	".gitignore",
	"README.md",
	"migrations/.gitkeep",
	"package.json",
	"pnpm-workspace.yaml",
	"src/app.ts",
	"src/context.ts",
	"src/index.ts",
	"src/request-store.ts",
	"tsconfig.json",
	"wrangler.jsonc",
];

let cwd: string;

const cli = (...argv: string[]) => {
	const out = { stdout: "", stderr: "" };
	const code = run(argv, {
		stdout: (text) => {
			out.stdout += text;
		},
		stderr: (text) => {
			out.stderr += text;
		},
		cwd,
	});
	return { code, ...out };
};

const listFiles = (dir: string) =>
	readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
		.sort();

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "takebase-cli-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("takebase help", () => {
	it("lists implemented commands separately from planned ones", () => {
		const { code, stdout } = cli("--help");
		expect(code).toBe(0);
		const [implemented, planned] = stdout.split("Planned (not implemented yet):");
		for (const group of commandGroups) {
			expect(group.status === "implemented" ? implemented : planned).toMatch(new RegExp(`^  ${group.name} `, "m"));
		}
		expect(commandGroups.filter((group) => group.status === "implemented").map((group) => group.name)).toEqual([
			"init",
			"create",
			"dev",
			"build",
			"deploy",
			"doctor",
			"user",
			"tenant",
			"role",
			"invite",
			"collection",
			"migrate",
		]);
	});

	it("prints help with no arguments and the version with --version", () => {
		expect(cli().stdout).toContain("Usage: takebase <command>");
		expect(cli("--version")).toMatchObject({ code: 0, stdout: "0.0.0\n" });
		expect(cli("create", "--help").stdout).toContain("Usage: takebase create <dir>");
	});

	it("reports planned commands as not implemented instead of pretending", () => {
		const { code, stderr } = cli("backup", "create");
		expect(code).toBe(1);
		expect(stderr).toContain("`takebase backup` is planned but not implemented yet");
		expect(stderr).toContain("takebase --help");
	});

	it("rejects unknown commands and options with actionable errors", () => {
		expect(cli("frobnicate")).toMatchObject({ code: 2, stderr: expect.stringContaining("takebase --help") });
		const unknownOption = cli("create", "app", "--template", "remote");
		expect(unknownOption.code).toBe(2);
		expect(unknownOption.stderr).toContain("--template");
		expect(unknownOption.stderr).toContain("takebase create --help");
		expect(cli("create")).toMatchObject({ code: 2, stderr: expect.stringContaining("Missing target directory") });
		expect(cli("create", "a", "b")).toMatchObject({ code: 2, stderr: expect.stringContaining("Unexpected arguments") });
		expect(cli("create", "app", "--name")).toMatchObject({ code: 2 });
	});

	it("runs as an executable with Node", () => {
		const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("Planned (not implemented yet):");
		const planned = spawnSync(process.execPath, [bin, "migrate", "apply"], { encoding: "utf8" });
		expect(planned.status).toBe(1);
	});
});

describe("takebase create / init", () => {
	it("creates a starter with the expected files and project name", () => {
		const { code, stdout } = cli("create", "my-app");
		expect(code).toBe(0);
		expect(stdout).toContain('Created Takebase starter "my-app"');
		expect(stdout).toContain("\n  cd my-app\n");
		const target = join(cwd, "my-app");
		expect(listFiles(target)).toEqual(starterFiles);

		const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
		expect(pkg.name).toBe("my-app");
		const wrangler = parse(readFileSync(join(target, "wrangler.jsonc"), "utf8"));
		expect(wrangler).toMatchObject({ name: "my-app", main: "src/index.ts", compatibility_flags: ["nodejs_als"] });
		expect(wrangler.d1_databases[0].database_id).toBe("local-my-app");
		for (const file of starterFiles) expect(readFileSync(join(target, file), "utf8")).not.toContain("{{name}}");
	});

	it("copies no credentials or local secret files", () => {
		cli("create", "my-app");
		const target = join(cwd, "my-app");
		const files = listFiles(target);
		expect(files.filter((file) => /(^|\/)\.(env|dev\.vars)/.test(file))).toEqual([]);
		const secretPattern =
			/(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']+["']|-----BEGIN [A-Z ]*PRIVATE KEY|AIza[0-9A-Za-z_-]{35}/i;
		for (const file of files) expect(readFileSync(join(target, file), "utf8"), file).not.toMatch(secretPattern);
		expect(readFileSync(join(target, ".gitignore"), "utf8")).toMatch(/^\.dev\.vars$/m);
	});

	it("init writes into the current directory and uses --name", () => {
		mkdirSync(join(cwd, "Not_Valid"));
		cwd = join(cwd, "Not_Valid");
		expect(cli("init")).toMatchObject({ code: 2, stderr: expect.stringContaining("--name") });
		expect(cli("init", "--name", "acme")).toMatchObject({ code: 0 });
		expect(listFiles(cwd)).toEqual(starterFiles);
		expect(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).name).toBe("acme");
	});

	it("allows an existing empty directory or one holding only .git", () => {
		mkdirSync(join(cwd, "empty"));
		mkdirSync(join(cwd, "repo", ".git"), { recursive: true });
		expect(cli("create", "empty").code).toBe(0);
		expect(cli("init", "repo").code).toBe(0);
	});

	it("refuses a non-empty destination without --force and writes nothing", () => {
		const target = join(cwd, "app");
		mkdirSync(target);
		writeFileSync(join(target, "package.json"), '{"name":"mine"}');
		const refused = cli("create", "app");
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("is not empty");
		expect(refused.stderr).toContain("--force");
		expect(listFiles(target)).toEqual(["package.json"]);
		expect(cli("init", "app").code).toBe(1);

		expect(cli("create", "app", "--force").code).toBe(0);
		expect(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).name).toBe("app");
	});

	it("rejects invalid names and unsafe target paths", () => {
		expect(cli("create", "app", "--name", "Bad Name")).toMatchObject({
			code: 2,
			stderr: expect.stringContaining("Invalid project name"),
		});
		expect(cli("create", "/")).toMatchObject({ code: 1, stderr: expect.stringContaining("filesystem root") });
		expect(cli("create", "bad\0dir")).toMatchObject({ code: 2 });

		writeFileSync(join(cwd, "file"), "");
		expect(cli("create", "file")).toMatchObject({ code: 1, stderr: expect.stringContaining("not a directory") });

		const outside = mkdtempSync(join(tmpdir(), "takebase-outside-"));
		try {
			symlinkSync(outside, join(cwd, "linked"));
			expect(cli("create", "linked")).toMatchObject({ code: 1, stderr: expect.stringContaining("symbolic link") });

			// A link inside the target must not redirect writes elsewhere, even with --force.
			mkdirSync(join(cwd, "app"));
			symlinkSync(outside, join(cwd, "app", "src"));
			expect(cli("init", "app", "--force")).toMatchObject({
				code: 1,
				stderr: expect.stringContaining("not a regular directory"),
			});
			expect(readdirSync(outside)).toEqual([]);
			expect(existsSync(join(cwd, "app", "package.json"))).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
