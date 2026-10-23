import { type ParseArgsConfig, parseArgs } from "node:util";
import { CliError } from "./errors.ts";

type Options = NonNullable<ParseArgsConfig["options"]>;

// Strict parsing: unknown options and missing option values are usage errors.
export const parseCommandArgs = <const T extends Options>(command: string, args: string[], options: T) => {
	try {
		return parseArgs({ args, options, allowPositionals: true, strict: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new CliError(message, { usage: true, hint: `Run \`takebase ${command} --help\` for usage.` });
	}
};
