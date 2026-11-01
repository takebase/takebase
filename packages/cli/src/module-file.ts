import { extname } from "node:path";
import { fileURLToPath } from "node:url";

// A module the CLI runs as its own process: `.ts` from the workspace's source,
// `.js` once built into the package.
export const moduleFile = (path: string, base: string) => {
	const file = fileURLToPath(base);
	return fileURLToPath(new URL(`${path}${extname(file)}`, base));
};
