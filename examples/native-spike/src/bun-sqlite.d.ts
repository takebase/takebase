// The part of Bun's built-in SQLite this spike uses, declared here so nothing is installed.
declare module "bun:sqlite" {
	export type Binding = string | number | bigint | boolean | null | Uint8Array;
	export type Statement = {
		all: (...values: Binding[]) => Record<string, unknown>[];
		values: (...values: Binding[]) => unknown[][];
	};
	export class Database {
		constructor(filename: string);
		exec: (sql: string) => void;
		query: (sql: string) => Statement;
		transaction: <Result>(fn: () => Result) => () => Result;
		close: () => void;
	}
}
