# Takebase

Takebase is a Cloudflare-native, PocketBase-inspired backend framework: TypeScript and Hono on Workers, with an independent D1 database per tenant, Firebase Auth for identity and Firebase RTDB for change notifications.

> Early development. Nothing here is published or production-ready yet.

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | `@takebase/core`, the framework package (currently the typed per-request store) |
| `examples/workers/global` | Example global Worker: tenant discovery, its own D1 database |
| `examples/workers/tenant` | Example tenant Worker: one deployment per tenant, each with its own D1 database (`tenant-a`, `tenant-b` locally) |
| `examples/sveltekit` | Blank SvelteKit frontend on Workers static assets, with no data bindings |
| `migrations/global`, `migrations/tenant` | D1 migrations (empty for now) |
| `tests/architecture` | Cross-package boundary checks |
| `firebase/`, `firebase.json` | Local Firebase Auth/RTDB emulators (see `firebase/README.md`) |

## Development

Requires Node.js 24 and pnpm (version pinned in `package.json`).

```sh
pnpm install
pnpm lint        # Biome
pnpm typecheck   # TypeScript and svelte-check in every package
pnpm test        # Workers tests in the Workers runtime, plus architecture checks
pnpm build       # core declarations, Worker bundles (wrangler --dry-run) and the SvelteKit build
pnpm test:firebase   # Firebase emulator checks; needs the Firebase CLI and Java
```

Run a Worker locally from its directory with `pnpm dev`, for example `pnpm --filter @takebase/example-tenant dev -- --env tenant-a`. All D1 databases are local; no Cloudflare account is needed for development or tests.

## Contributing

Development happens on the Gitea repository, which runs CI and mirrors to GitHub. Branches are named `feature/<ISSUE-KEY>-<description>` and commit subjects start with the issue key.
