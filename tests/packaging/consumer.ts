import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The packed packages installed from their tarballs into a directory outside
// the workspace, so workspace links cannot hide a missing file or a bad export.

const root = fileURLToPath(new URL("../..", import.meta.url));

export const packed = ["contracts", "core", "sdk", "adapter-firebase", "cli"] as const;
export type PackedName = (typeof packed)[number];

export const tarballName = (name: PackedName) => `takebase-${name}-0.0.0.tgz`;

export const sh = (cwd: string, command: string, args: string[]) => {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const required = (cwd: string, command: string, args: string[]) => {
	const result = sh(cwd, command, args);
	if (result.code !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`);
	}
	return result;
};

export type Consumer = { dir: string; packs: string; remove: () => void };

export const packAll = (packs: string) => {
	mkdirSync(packs, { recursive: true });
	for (const name of packed) {
		required(join(root, "packages", name), "pnpm", ["pack", "--pack-destination", packs]);
	}
};

// Nothing is on a registry yet, so each package's dependency on another
// resolves to its tarball too.
export const tarballOverrides = (packs: string) => [
	"overrides:",
	...packed.map((name) => `  "@takebase/${name}": "file:${join(packs, tarballName(name))}"`),
];

export const installConsumer = (): Consumer => {
	const base = mkdtempSync(join(tmpdir(), "takebase-packaging-"));
	const packs = join(base, "packs");
	const dir = join(base, "consumer");
	mkdirSync(dir);
	packAll(packs);
	const tarball = (name: PackedName) => `file:${join(packs, tarballName(name))}`;
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			name: "takebase-consumer",
			private: true,
			type: "module",
			dependencies: {
				"@takebase/adapter-firebase": tarball("adapter-firebase"),
				"@takebase/cli": tarball("cli"),
				"@takebase/core": tarball("core"),
				"@takebase/sdk": tarball("sdk"),
			},
			devDependencies: { "drizzle-kit": "0.31.11", typescript: "^6.0.3" },
		}),
	);
	writeFileSync(
		join(dir, "pnpm-workspace.yaml"),
		[...tarballOverrides(packs), "allowBuilds:", "  esbuild: true", ""].join("\n"),
	);
	required(dir, "pnpm", ["install", "--no-frozen-lockfile"]);
	return { dir, packs, remove: () => rmSync(base, { recursive: true, force: true }) };
};
