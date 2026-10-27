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

## Collection rules and the SDK

Rules are deny-by-default and enforced here, never in the SDK:

```ts
rules: { list: tenantMember(), view: tenantMember(), create: hasRole("agent"), update: tenantMember(), delete: deny() }
```

- An identity exists only for a verified member of this tenant (checked with the global Worker on every request), so `tenantMember()` means "signed in and a member here". `hasRole(...roles)` passes for any one of the roles.
- Custom routes that query Drizzle directly must call `await authorize(collection, operation, auth)` first, like Laravel's `Gate::authorize()`. It applies the collection's own rules and throws a 401/403 `AuthError`.

The SDK signs nothing in itself; the app signs in with Firebase and hands over its `Auth` instance:

```ts
const client = createClient({ globalUrl: "https://auth.example.com", auth: getAuth(app) });
const tenants = await client.auth.getTenants();
await client.useTenant(tenants[0].tenant.id);
const policies = client.collection("policies");
```

The tenant URL always comes from discovery. Tokens go only to the global URL and that URL over HTTPS, and a 401 triggers one forced token refresh. Switching tenant, a different user or `client.auth.signOut()` makes earlier collection handles reject with `tenant_changed`.

## Realtime (Firebase Realtime Database)

Each tenant has its own Realtime Database. RTDB only says "this collection changed": `/collections/{name} = { revision }`. Clients then refetch through this API, where the collection rules decide what they may see. Signals never carry record ids or data.

- **Dispatch:** every committed create, update or delete writes an outbox event in the same D1 batch. After the response (`waitUntil`) and whenever a member opens a session, the Worker publishes the highest revision per collection. A failure leaves the event pending with a backoff; D1 data is never touched. There is no cron.
- **Sessions:** `POST /api/realtime/session` grants a verified member read access at the tenant's access revision from global D1, and returns the non-secret connection settings.
- **Revocation:** any "not a member" answer from the global Worker removes that user's grant at once. The rules reject a grant older than the latest revocation, so a membership check that raced a removal cannot restore access.
- **Disabled tenant:** disabling a tenant in global D1 also records a tenant-wide revocation, in the same statement (a trigger on `tenants`). `POST /api/realtime/reconcile` delivers it: the Worker asks the global Worker what is owed, removes every grant (`revokeAll`), and only then confirms it. The call carries no authority, so anyone may trigger it and repeating it changes nothing. A failure leaves the revocation pending for the next call. `takebase tenant disable` calls it.
- **Removed, disabled or signed-out user:** global D1 also records a revocation for one user when they lose their last role in this tenant, are disabled or deleted, or have their sessions revoked. Reconcile delivers these too, one `revoke(uid, rev)` per user and each confirmed afterwards. Opening a session reconciles first, so a pending revocation is never written over a newer grant.
- **Rules:** `databaseRules(dispatcherUid)` from `@takebase/adapter-firebase` renders the rules for one tenant. Only that tenant's dispatcher user writes signals and grants. Members may only delete their own grant and write their own server-timestamped presence; everything else is denied.

Realtime is on when the Worker has `FIREBASE_DATABASE_URL`, `FIREBASE_API_KEY` (vars) and the dispatcher's `FIREBASE_DISPATCHER_EMAIL` and `FIREBASE_DISPATCHER_PASSWORD` (secrets only). Without the secrets, sessions answer 503 and the API works as before.

### Local development

The emulators run only `demo-*` projects; nothing here reaches Firebase.

1. From the repository root: `firebase emulators:start --only auth,database --project demo-takebase`.
2. Create the dispatcher user in the Auth emulator and note its `localId`:
   ```sh
   curl -s -X POST 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key' \
     -H 'content-type: application/json' \
     -d '{"email":"dispatcher-local@example.test","password":"local-only-password","returnSecureToken":true}'
   ```
3. Load the rules into this tenant's namespace (`FIREBASE_DATABASE_NAMESPACE` in `wrangler.jsonc`), replacing `<uid>`:
   ```sh
   node --input-type=module -e "import { databaseRules } from '@takebase/adapter-firebase/rules'; console.log(JSON.stringify(databaseRules('<uid>')))" > /tmp/rules.json
   curl -s -X PUT 'http://127.0.0.1:9000/.settings/rules.json?ns=demo-takebase-local' -H 'authorization: Bearer owner' -d @/tmp/rules.json
   ```
4. Copy `.dev.vars.example` to `.dev.vars` and run `pnpm dev`.

`pnpm test:realtime` (repository root) runs the rules and the end-to-end Worker tests against the emulators. It needs Java and runs locally only.
