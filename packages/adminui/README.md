# Takebase admin

The SvelteKit admin (SEGU-222): sign in with Firebase Auth, pick one of your tenants and administer it through the public `@takebase/sdk`, the same SDK an application uses. The admin holds no authority. The global and tenant Workers decide every request, so a tenant's admin screens work only for holders of its `admin` role.

It is a static single-page app (`@sveltejs/adapter-static`, `ssr = false`): `pnpm --filter @takebase/adminui build` writes it to the repository's `public/` folder (git-ignored) for Cloudflare Pages. There is no server code, no D1 access and no secret in it.

## Run it

`pnpm dev:stack` from the repository root serves it at `http://localhost:5174`, next to the app on 5173, on emulators and local D1 only.

## How it is built

- `src/lib/edge.ts` creates the one Firebase app and Takebase client. With a `demo-*` project it talks only to the Auth emulator. Set `VITE_TAKEBASE_GLOBAL_URL`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID` and `VITE_FIREBASE_AUTH_EMULATOR_URL` to point it elsewhere.
- `src/lib/stores/session.svelte.ts` holds the user, their tenants and the selected tenant. Other stores register a reset there, and it clears them all on a tenant switch and on every SDK sign-out or revocation.
- Components render the stores and never call Firebase or the client directly.

`pnpm check` runs svelte-check.
