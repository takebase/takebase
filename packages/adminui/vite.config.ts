import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
			},
			// A static single-page app for Cloudflare Pages, written to the repository's
			// public/ folder. Every route falls back to index.html; nothing is rendered
			// on a server.
			adapter: adapter({ pages: "../../public", assets: "../../public", fallback: "index.html" }),
		}),
	],
});
