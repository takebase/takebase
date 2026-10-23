# Takebase

Takebase is a Cloudflare-native, PocketBase-inspired backend framework: TypeScript and Hono on Workers, with an independent D1 database per tenant, Firebase Auth for identity and Firebase RTDB for change notifications.

> Early development. Nothing here is published or production-ready yet.

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | `@takebase/core`, the server framework package (currently the typed per-request store) |
| `packages/contracts` | `@takebase/contracts`, HTTP error/list envelopes, collection operations and tenant types; no dependencies |
| `packages/sdk` | `@takebase/sdk`, the client SDK (currently typed errors and response parsing); depends only on contracts |
| `packages/cli` | `@takebase/cli`, the `takebase` command and its bundled local starter template |
| `examples/workers/global` | Example global Worker: tenant discovery, its own D1 database |
| `examples/workers/tenant` | Example tenant Worker: one deployment per tenant, each with its own D1 database (`tenant-a`, `tenant-b` locally) |
| `examples/sveltekit` | Blank SvelteKit frontend on Workers static assets, with no data bindings |
| `migrations/global`, `migrations/tenant` | D1 migrations (empty for now) |
| `tests/architecture`, `tests/contracts`, `tests/cli` | Package boundary, public API and CLI checks |
| `firebase/`, `firebase.json` | Local Firebase Auth/RTDB emulators (see `firebase/README.md`) |

## Development

Requires Node.js 24 and pnpm (version pinned in `package.json`).

```sh
pnpm install
pnpm lint        # Biome
pnpm typecheck   # TypeScript and svelte-check in every package
pnpm test        # Workers tests in the Workers runtime, plus architecture, contract and CLI checks
pnpm build       # core declarations, Worker bundles (wrangler --dry-run) and the SvelteKit build
pnpm test:firebase   # Firebase emulator checks; needs the Firebase CLI and Java
```

Run a Worker locally from its directory with `pnpm dev`, for example `pnpm --filter @takebase/example-tenant dev -- --env tenant-a`. All D1 databases are local; no Cloudflare account is needed for development or tests.

## CLI

Run the CLI from the repository with `node packages/cli/src/bin.ts <command>` (Node.js 24 runs the TypeScript source directly). `takebase --help` lists the supported and planned commands.

```sh
node packages/cli/src/bin.ts create my-app   # new starter in ./my-app
node packages/cli/src/bin.ts init            # starter in the current directory
```

`init` and `create` copy a local Hono + D1 Worker starter. They refuse a non-empty directory unless `--force` is given, never follow symbolic links, and copy no credentials.

| Command group | Capabilities | Status |
| --- | --- | --- |
| `init` / `create` | Generate a project starter | Implemented |
| `dev` / `build` / `deploy` | Development and deployment | Planned |
| `doctor` | Validate environment and configuration | Planned |
| `user` | Create, list, disable, enable, delete users; revoke sessions | Planned |
| `tenant` | Create, list, provision, disable, delete tenants | Planned |
| `tenant user` | Add/remove members and assign roles | Planned |
| `role` / `invite` | Manage roles and invitations | Planned |
| `collection` | Generate and inspect collections | Planned |
| `migrate` | Generate, inspect and apply migrations | Planned |
| `wire` | Test notifications and retry failed deliveries | Planned |
| `secrets` | Initialize, rotate, check and revoke secrets | Planned |
| `backup` | Create, list, verify, restore and prune backups | Planned |
| `logs` / `health` | Diagnostics and monitoring | Planned |

Planned commands exit with an error saying they are not implemented yet.

## Contributing

Development happens on the Gitea repository, which runs CI and mirrors to GitHub. Branches are named `feature/<ISSUE-KEY>-<description>` and commit subjects start with the issue key.
