import { AsyncLocalStorage } from "node:async_hooks";
import type { AppContext } from "./context.ts";

// Per-request context. Requires the `nodejs_als` compatibility flag. Each entry point
// (fetch, cron, queue, Workflow step, RPC method) opens its own scope with runInRequest.
const storage = new AsyncLocalStorage<AppContext>();

export const runInRequest = <Result>(context: AppContext, fn: () => Result) => storage.run(context, fn);

export const useContext = () => {
	const context = storage.getStore();
	if (!context) throw new Error("No request scope: wrap the entry point in runInRequest()");
	return context;
};
