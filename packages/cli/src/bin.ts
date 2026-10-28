#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { CliError, run } from "./index.ts";

// Key material comes only from a pipe or file: a terminal would echo it.
const readStdin = () => {
	if (process.stdin.isTTY) {
		throw new CliError("Standard input is a terminal; pipe the key in instead", {
			hint: "For example `openssl rand -base64 32 | takebase secrets init <tenant> --stdin`. Nothing was changed.",
		});
	}
	return readFileSync(0, "utf8");
};

process.exitCode = await run(process.argv.slice(2), {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	cwd: process.cwd(),
	stdin: readStdin,
});
