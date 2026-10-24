# `@takebase/firebase-rtdb`

REST-only Firebase Realtime Database client for Cloudflare Workers and Node.js:
read and write any path with any JSON. It knows nothing about the data it
carries; record contracts belong to the code that uses it. Takebase's Firebase
realtime adapter writes collection revisions and member grants through it.

- Authentication is Firebase Auth email/password with user-scoped ID tokens, so
  Database Security Rules apply to the backend too. There is no SDK,
  service-account, database-secret or Admin authentication.
- `databaseURL` selects the target. Exactly `http://127.0.0.1:9000`
  (`EMULATOR_URL`) is the local emulator; anything else must be an HTTPS
  Firebase origin (`*.firebaseio.com` or `*.firebasedatabase.app`) without path,
  query, fragment, port or user information.
- Redirects are never followed. Errors carry a fixed `code` and message and
  never contain URLs, paths, tokens, credentials or response bodies.
- Runtime code uses only `fetch`, Web Streams, `AbortSignal` and `TextEncoder`;
  there are no runtime dependencies and no Node-only APIs.

## Origin

Copied from `@segutrends/segufirebase` 0.0.2 (commit `255efc9`) on 2026-10-24
(SEGU-240). The two packages are maintained separately from here on. Takebase
added:

- `getWithETag` and `setIfUnchanged` (conditional writes, `conflict` on a changed value);
- the retryable `unavailable` code for 408, 429 and 5xx, plus `isRetryable(error)`;
- signing in as a real user through the Auth emulator (`authEmulatorURL`), so
  local tests run the database rules exactly as production does.

It is private and unpublished until Takebase's license is chosen (SEGU-239).

## Usage

```ts
import { createClient, SERVER_TIMESTAMP } from "@takebase/firebase-rtdb";

const client = createClient({
	databaseURL: env.FIREBASE_DATABASE_URL,
	apiKey: env.FIREBASE_API_KEY,
	email: env.FIREBASE_DISPATCHER_EMAIL,
	password: env.FIREBASE_DISPATCHER_PASSWORD,
});

await client.set("presence/abc", { online: true, lastSeen: SERVER_TIMESTAMP });

// Compare-and-set: only one writer wins; the other gets code "conflict".
const { value, etag } = await client.getWithETag<{ revision: number } | null>("collections/policies");
if ((value?.revision ?? 0) < 42) await client.setIfUnchanged("collections/policies", { revision: 42 }, etag);
```

| Method | REST call | Success |
| --- | --- | --- |
| `get<T>(path)` | `GET` | parsed JSON (`null` when absent) |
| `getWithETag<T>(path)` | `GET` + `X-Firebase-ETag: true` | `{ value, etag }` |
| `set(path, value)` | `PUT ?print=silent` | `204` |
| `setIfUnchanged(path, value, etag)` | `PUT` + `if-match` | `200`; `412` fails with `conflict` |
| `update(path, fields)` | `PATCH ?print=silent` | `204`; field names may be nested `a/b` paths |
| `push(path, value)` | `POST` | the generated key, validated as a Firebase key |
| `delete(path)` | `DELETE ?print=silent` | `204` |

Paths are one or more Firebase keys separated by `/`; surrounding slashes are
trimmed. Each key is non-empty, at most 768 UTF-8 bytes and contains no control
characters or `. # $ [ ] /`. `isValidKey` exposes the same check.

Every method accepts `{ signal }`. Each request has its own budget
(`timeoutMs`, default 10 seconds) that covers sign-in and the response body;
`maxResponseBytes` (default 16 MiB) caps response bodies.

### Cloudflare Workers

Create the client in the Worker's composition root (`createContext`), not as a
module-level variable. Sign-in happens on the first request; concurrent requests
on the same client share one sign-in or refresh. Store the password (and
preferably the API key and email) as Worker secrets.

### Tokens

ID tokens are cached and refreshed through `securetoken.googleapis.com` 30
seconds before they expire. A `401`/`403` from the database fails the request
with `denied` and forces the next request to refresh. A refresh token that
Firebase rejects (for example after a password change) is final for that client:
create a new client.

### Errors

All failures are `FirebaseRtdbError` with one of these `code` values.
`isRetryable(error)` is true for `timeout`, `connection_failed`, `unavailable`
and `auth_unavailable`.

| Code | Meaning |
| --- | --- |
| `invalid_options` | bad `databaseURL`, credentials, namespace, Auth emulator URL or limits |
| `invalid_path` / `invalid_value` | rejected before any request |
| `auth_rejected` | wrong credentials, disabled user, Email/Password provider off |
| `auth_unavailable` | sign-in or refresh failed temporarily (network, 408, 429, 5xx, bad response) |
| `denied` | `401`/`403` from the database; check Security Rules |
| `conflict` | `setIfUnchanged` found a different value (`412`) |
| `unavailable` | the database answered `408`, `429` or `5xx`; retry later |
| `timeout` / `aborted` | request budget elapsed / caller's signal aborted |
| `connection_failed` | the database could not be reached |
| `request_failed` | any other unexpected status, including redirects |
| `invalid_response` | body too large, not JSON, a missing ETag or an invalid push key |
| `closed` | `close()` was called |

### Emulator

```ts
// Admin access for test setup (the emulator's `owner` token; rules do not apply).
const admin = createClient({ databaseURL: EMULATOR_URL, emulatorNamespace: "demo-takebase-tenant-a" });

// A real user signed in through the Auth emulator; rules apply as in production.
const user = createClient({
	databaseURL: EMULATOR_URL,
	authEmulatorURL: AUTH_EMULATOR_URL,
	emulatorNamespace: "demo-takebase-tenant-a",
	email: "dispatcher@example.com",
	password: "local-only",
});
```

`AUTH_EMULATOR_URL` is exactly `http://127.0.0.1:9099` and is accepted only
together with the database emulator.

## Tests

- `pnpm --filter @takebase/firebase-rtdb test`: unit tests with a scripted `fetch`.
- `pnpm test:firebase-rtdb` (from the repository root): the same client against
  the real Auth and Database emulators (Java required; local only).
- `examples/workers/tenant/test/firebase-rtdb.test.ts`: runs the client inside workerd.
