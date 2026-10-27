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
- Disabling a tenant also records a tenant-wide realtime revocation in `tenant_revocations` (migration `0004`, a trigger). Tenant Workers fetch and confirm it with `pendingRevocation` / `confirmRevocation` on the same RPC entrypoint. A tenant enabled again owes nothing. Per-user revocations (`member_revocations`) go the same way through `pendingMemberRevocations` / `confirmMemberRevocation`.
- Administration (migrations `0005`, `0006`, SEGU-220) is enforced by triggers, so every path obeys it:
  - Each tenant declares its roles in `tenant_roles`. `admin` is built in, and a membership or invitation with an undeclared role is refused.
  - A tenant that has admins always keeps at least one. Deleting the tenant itself still cascades.
  - When a user loses their last role in a tenant, a row is added to `member_revocations` at the revision that change produced. The same happens in every tenant of an identity whose `identities` row is disabled, deleted or has its sessions revoked.
  - `invitations` stores only token hashes, and `audit_events` is append-only.
- ID tokens are verified offline (RS256 against Google's securetoken keys). Offline verification **cannot** detect a revoked or disabled Firebase user until the token expires, at most one hour after it was issued. Takebase's own `identities` row closes that gap: a disabled or deleted identity, or a token whose `auth_time` is not after `sessions_valid_after`, gets 401 here and in every tenant Worker.

## Tenant administration and invitations

- `/api/admin/tenants/{id}/members|roles|invites` is for holders of that tenant's built-in `admin` role, in an active tenant, and only that tenant. Anyone else gets 403, including another tenant's admin; an unknown tenant answers the same. It lists, adds and removes members and roles, and creates, lists and revokes invitations.
  - Each change is audited as `firebase:<uid>`.
  - Undeclared roles get 422 (`fields.role`). Duplicates, the built-in admin role and the last admin get 409.
  - A member removal answers `{ reconcile }`: POST it to deliver the realtime revocation now.
- `POST /api/invites/redeem` with `{ token }` gives the signed-in caller the invitation's role (`client.invites.redeem(token)` in the SDK).
  - A token works once, before it expires, while the tenant is active and its role still exists. Anything else gets the same 404.
  - Redemption is one guarded `UPDATE` plus the membership in a single batch, so concurrent redemptions cannot both win.
- There is no superuser route: the platform operator uses the `takebase user|tenant user|role|invite` CLI commands.
- Local Auth-emulator tokens are unsigned. They are trusted only with `TAKEBASE_AUTH_EMULATOR=local-only` and a `demo-*` `FIREBASE_PROJECT_ID`; any other combination fails every request. Set it in `.dev.vars` for `wrangler dev`, never in `wrangler.jsonc`.
- Schema changes: `takebase migrate generate --name <name>`, then `takebase migrate apply`, from this directory. The emulator scenario runs with `pnpm test:emulator`.
