# SvelteKit example

The Takebase local milestone app: sign in with Firebase Auth, pick one of your tenants, create policies and watch the list follow realtime signals. It uses `@takebase/sdk` with the browser connector from `@takebase/adapter-firebase/client`, exactly as an application would.

## Run it

From the repository root (needs the Firebase CLI and Java for the emulators):

```sh
pnpm install
pnpm dev:stack
```

This starts, on emulators and local D1 only:

| What | Where |
| --- | --- |
| Firebase Auth and RTDB emulators (`demo-takebase`) | `127.0.0.1:9099`, `127.0.0.1:9000` |
| Global Worker (tenant discovery) | `http://localhost:8787` |
| Tenant Workers `tenant-a`, `tenant-b` | `http://localhost:8788`, `http://localhost:8789` |
| This app | `http://localhost:5173` |

Every start seeds fresh emulator users, a dispatcher and database rules per tenant, and empty tenant databases. Ctrl-C stops everything. Nothing reaches Firebase or Cloudflare.

## Try it

The password for every seeded user is `local-only-password`.

| User | Tenant A | Tenant B |
| --- | --- | --- |
| `alice@example.test` | agent | agent |
| `bob@example.test` | member | — |

1. Sign in as alice and select Tenant A.
2. Create a policy, for example `ABC123` / any holder / `pending`. The list updates from the realtime signal: the app refetches only when a signal arrives, never after its own create.
3. Open a second window, sign in as alice and create a policy there: the first window updates too.
4. Select Tenant B. Its list is empty, and changes in Tenant A no longer reach this window.
5. Sign in as bob: only Tenant A is listed, and creating a policy is refused (members may not create).
6. Sign out. The app forgets the user, tenant and list.

If a user's membership is removed while they are signed in, their next request is refused, the tenant revokes their realtime access and the app signs them out with a notice. This happens even if they belong to other tenants.

## How it is built

- `src/lib/edge.ts` creates the one Firebase app and Takebase client. With a `demo-*` project it talks only to the Auth emulator. Set `VITE_TAKEBASE_GLOBAL_URL`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID` and `VITE_FIREBASE_AUTH_EMULATOR_URL` to point it elsewhere.
- `src/lib/stores/session.svelte.ts` holds the user, their tenants and the selected tenant. It runs one policies subscription per selected tenant and clears all state on sign-out or revocation.
- `src/lib/stores/policies/` holds the policies list. Only the latest load may write it, so a slow response from before a tenant switch is dropped.
- `src/routes/+page.svelte` renders the stores. Components never call Firebase or the client directly.

The app runs in the browser only (`ssr = false`); every record comes from the tenant API, whose collection rules decide what the user may see.

## Tests

`pnpm test:e2e` from the repository root starts a fresh stack and drives this app in Chromium (`tests/e2e/protected-realtime.spec.ts`). Install the browser once with `pnpm exec playwright install chromium`. `pnpm check` runs svelte-check.
