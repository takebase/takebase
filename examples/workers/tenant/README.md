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
