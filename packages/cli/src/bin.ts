#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { run } from "./index.ts";

process.exitCode = await run(process.argv.slice(2), {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	cwd: process.cwd(),
	stdin: () => readFileSync(0, "utf8"),
});
