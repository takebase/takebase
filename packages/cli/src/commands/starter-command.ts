import { relative } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { CliError, type CliIo } from "../errors.ts";
import { writeStarter } from "../starter.ts";

const options = {
	name: { type: "string" },
	force: { type: "boolean" },
	help: { type: "boolean", short: "h" },
} as const;

type StarterCommand = {
	command: "init" | "create";
	usage: string;
	defaultDir: string | undefined;
	help: string;
};

const nextSteps = (io: CliIo, target: string) => {
	const dir = relative(io.cwd, target);
	const steps = dir === "" ? [] : [`cd ${dir.startsWith("..") ? target : dir}`];
	return [...steps, "pnpm install", "pnpm dev"].map((step) => `  ${step}`).join("\n");
};

export const runStarterCommand = (spec: StarterCommand, args: string[], io: CliIo) => {
	const { values, positionals } = parseCommandArgs(spec.command, args, options);
	if (values.help === true) {
		io.stdout(spec.help);
		return 0;
	}
	if (positionals.length > 1) {
		throw new CliError(`Unexpected arguments: ${positionals.slice(1).join(" ")}`, {
			usage: true,
			hint: `Usage: ${spec.usage}`,
		});
	}
	const dir = positionals[0] ?? spec.defaultDir;
	if (dir === undefined) {
		throw new CliError("Missing target directory", { usage: true, hint: `Usage: ${spec.usage}` });
	}

	const result = writeStarter({ cwd: io.cwd, dir, name: values.name, force: values.force === true });
	io.stdout(
		`Created Takebase starter "${result.name}" in ${result.target}\n` +
			`${result.files.map((file) => `  ${file}`).join("\n")}\n\nNext steps:\n${nextSteps(io, result.target)}\n`,
	);
	return 0;
};

export const starterOptionsHelp = `Options:
  --name <name>  Project and Worker name (default: the directory name)
  --force        Write into a non-empty directory, overwriting files with the same names
  -h, --help     Show this help
`;
