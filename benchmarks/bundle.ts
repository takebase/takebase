import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// What a Worker uploads and how long its top-level code takes to run, from
// Wrangler's own dry run and startup profile. Both run locally and upload nothing.

export type BundleResult = {
	worker: string;
	bytes: number | null;
	gzipBytes: number | null;
	startupMs: number | null;
	note: string;
};

const wrangler = (cwd: string, args: string[]) =>
	spawnSync("pnpm", ["exec", "wrangler", ...args], { cwd, encoding: "utf8", timeout: 180_000 });

const filesIn = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? filesIn(path) : [path];
	});

export const measureBundle = (worker: string, dir: string, env?: string): BundleResult => {
	const environment = env === undefined ? [] : ["--env", env];
	const out = mkdtempSync(join(tmpdir(), "takebase-bundle-"));
	const notes: string[] = [];
	let bytes: number | null = null;
	let gzipBytes: number | null = null;
	let startupMs: number | null = null;
	try {
		const outdir = join(out, "bundle");
		const built = wrangler(dir, ["deploy", "--dry-run", "--outdir", outdir, ...environment]);
		if (built.status === 0) {
			const contents = filesIn(outdir)
				.filter((path) => path.endsWith(".js"))
				.map((path) => readFileSync(path));
			bytes = contents.reduce((total, content) => total + content.byteLength, 0);
			gzipBytes = contents.reduce((total, content) => total + gzipSync(content).byteLength, 0);
		} else notes.push("dry run failed");
		const profile = join(out, "startup.cpuprofile");
		const started = wrangler(dir, ["check", "startup", "--outfile", profile, ...environment]);
		if (started.status === 0) {
			const { startTime, endTime } = JSON.parse(readFileSync(profile, "utf8")) as {
				startTime: number;
				endTime: number;
			};
			startupMs = Math.round((endTime - startTime) / 100) / 10;
		} else notes.push("startup profile unavailable");
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
	return { worker, bytes, gzipBytes, startupMs, note: notes.join("; ") };
};
