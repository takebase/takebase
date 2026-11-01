import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packAll, tarballName, tarballOverrides } from "../packaging/consumer.ts";

// S-7-3-01: a project a user would get. The packed CLI generates it, its Takebase
// packages install from the tarballs, it typechecks, `tenant create` adds a second
// tenant, and then it serves through its own `pnpm dev`. Emulators and local D1 only.
// `pnpm e2e:starter` runs this as Playwright's web server, so it stops on SIGTERM.

export const starterBase = join(tmpdir(), "takebase-generated-starter");
export const starterDir = join(starterBase, "generated-app");

const step = (label: string, command: string, args: string[], cwd = starterDir) => {
	console.log(`[starter] ${label}`);
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`${label} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
	}
	return result.stdout;
};

export const prepareStarter = () => {
	rmSync(starterBase, { recursive: true, force: true });
	const packs = join(starterBase, "packs");
	const cli = join(starterBase, "cli");
	mkdirSync(cli, { recursive: true });
	packAll(packs);
	step("unpack the CLI", "tar", ["-xzf", join(packs, tarballName("cli")), "-C", cli], starterBase);
	step("takebase create", process.execPath, [join(cli, "package/dist/bin.js"), "create", "generated-app"], starterBase);
	// Published versions would come from the registry; these come from the tarballs.
	appendFileSync(join(starterDir, "pnpm-workspace.yaml"), `${tarballOverrides(packs).join("\n")}\n`);
	step("pnpm install", "pnpm", ["install", "--no-frozen-lockfile"]);
};

export const verifyStarter = () => {
	step("pnpm typecheck", "pnpm", ["typecheck"]);
	step("global migrations", "pnpm", ["exec", "takebase", "migrate", "apply", "--worker", "workers/global"]);
	step("takebase tenant create", "firebase", [
		"emulators:exec",
		"--only",
		"auth,database",
		"--project",
		"demo-generated-app",
		"node_modules/.bin/takebase tenant create acme --name Acme --port 8789",
	]);
};

const serve = () => {
	const dev = spawn("pnpm", ["dev"], { cwd: starterDir, stdio: "inherit" });
	const stop = () => {
		dev.kill("SIGTERM");
		spawnSync("pnpm", ["dev:stop"], { cwd: starterDir, stdio: "inherit" });
		// About 680 MB. A run that dies earlier leaves it to debug; the next run removes it.
		rmSync(starterBase, { recursive: true, force: true, maxRetries: 3 });
		process.exit(0);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	dev.on("exit", (code) => process.exit(code ?? 1));
};

if (process.argv[1]?.endsWith("generated-starter.ts")) {
	prepareStarter();
	if (process.argv[2] !== "--prepare-only") {
		verifyStarter();
		serve();
	}
}
