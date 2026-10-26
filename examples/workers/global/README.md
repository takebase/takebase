```txt
npm install
npm run dev
```

```txt
npm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
npm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiating `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>();
```

## Identity and tenant discovery

- `GET /api/tenants` verifies the caller's `Authorization: Bearer <Firebase ID token>` and returns the active tenants the caller belongs to, with roles, from global D1.
- Tenant Workers check membership through the `MembershipEntrypoint` RPC over their `GLOBAL` service binding. It has no public URL. If the global Worker cannot answer, the tenant responds 503 and authenticates no one.
- Identity verification is an adapter (`IdentityProvider` in `@takebase/core`). Firebase is the first one; memberships key on `(provider, subject)`.
- Membership is read on every request, with no cache. Removing a member or disabling a tenant takes effect on the next request.
- Disabling a tenant also records a tenant-wide realtime revocation in `tenant_revocations` (migration `0004`, a trigger). Tenant Workers fetch and confirm it with `pendingRevocation` / `confirmRevocation` on the same RPC entrypoint. A tenant enabled again owes nothing.
- ID tokens are verified offline (RS256 against Google's securetoken keys). Offline verification **cannot** detect a revoked or disabled Firebase user until the token expires, at most one hour after it was issued.
- Local Auth-emulator tokens are unsigned. They are trusted only with `TAKEBASE_AUTH_EMULATOR=local-only` and a `demo-*` `FIREBASE_PROJECT_ID`; any other combination fails every request. Set it in `.dev.vars` for `wrangler dev`, never in `wrangler.jsonc`.
- Schema changes: `takebase migrate generate --name <name>`, then `takebase migrate apply`, from this directory. The emulator scenario runs with `pnpm test:emulator`.
