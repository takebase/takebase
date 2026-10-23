import { AsyncLocalStorage } from "node:async_hooks";

// Per-request state for Workers. Requires the `nodejs_als` compatibility flag.
// Each entry point (fetch, cron, queue, Workflow step, RPC method) opens its own
// scope with `runInRequest`; nothing request-specific lives at module scope.

type Scope<Context, Locals> = {
	context: Context;
	locals: Partial<Locals>;
};

export type RequestLocalsAccess<Locals> = {
	get: <Key extends keyof Locals>(key: Key) => Locals[Key] | undefined;
	set: <Key extends keyof Locals>(key: Key, value: Locals[Key]) => void;
};

export type RequestStore<Context, Locals> = {
	runInRequest: <Result>(context: Context, fn: () => Result) => Result;
	useContext: () => Context;
	requestLocals: RequestLocalsAccess<Locals>;
};

export const createRequestStore = <Context, Locals extends object = Record<never, never>>(): RequestStore<
	Context,
	Locals
> => {
	const storage = new AsyncLocalStorage<Scope<Context, Locals>>();

	const currentScope = () => {
		const scope = storage.getStore();
		if (!scope) throw new Error("No request scope: wrap the entry point in runInRequest()");
		return scope;
	};

	return {
		runInRequest: (context, fn) => storage.run({ context, locals: {} }, fn),
		useContext: () => currentScope().context,
		requestLocals: {
			get: (key) => currentScope().locals[key],
			set: (key, value) => {
				currentScope().locals[key] = value;
			},
		},
	};
};
