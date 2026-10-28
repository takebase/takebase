// Usage errors (bad arguments) exit with 2; refused or failed operations exit with 1.
// Every error carries a hint telling the user what to do next.
export class CliError extends Error {
	readonly exitCode: number;
	readonly hint: string | undefined;

	constructor(message: string, options: { hint?: string; usage?: boolean } = {}) {
		super(message);
		this.name = "CliError";
		this.exitCode = options.usage === true ? 2 : 1;
		this.hint = options.hint;
	}
}

export type CliIo = {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	cwd: string;
	// The whole of standard input (`takebase secrets init --stdin`); absent in
	// callers that never read it.
	stdin?: () => string;
};
