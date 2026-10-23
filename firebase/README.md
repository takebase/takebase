# Firebase local development (Auth + Realtime Database emulators)

Takebase uses Firebase Auth for global identity and the Realtime Database (RTDB) only for
lightweight change notifications. This folder documents the **local, emulator-only**
setup established in Wave 1-1 (SEGU-207). It is development/test infrastructure, not a
hosted application: Firebase Hosting and Cloud Functions are intentionally not configured.

## Files

| Path | Purpose |
| --- | --- |
| `firebase.json` | RTDB rules path plus Auth/RTDB emulator hosts and ports. |
| `.firebaserc` | Project aliases. Only `demo-*` projects are allowed until a remote wave is approved. |
| `database.rules.json` | RTDB security rules: deny all reads and writes (authorization arrives in a later wave). |
| `firebase/.env.example` | Public client configuration placeholders and emulator hosts. |
| `tests/firebase/bootstrap.test.ts` | Config checks plus emulator checks that RTDB denies unauthenticated and authenticated access. |

`firebase.json`, `.firebaserc` and `database.rules.json` were generated at the repository
root by `firebase init database --project demo-takebase --non-interactive` (firebase-tools
15.34.0), which keeps the CLI's default layout. `firebase init emulators` cannot run
non-interactively, so the `emulators` block was written by hand using the CLI's schema.

## Prerequisites

- Firebase CLI (`firebase --version`; verified with 15.34.0).
- Java 11+ for the RTDB emulator (verified with OpenJDK 21).
- Node.js 22.18+ / 24 to run the TypeScript test directly with `node --test`.

## Commands

Run from the repository root:

```sh
# Start Auth (127.0.0.1:9099) and RTDB (127.0.0.1:9000); Emulator UI is disabled.
firebase emulators:start --only auth,database --project demo-takebase

# Start, run a command, and stop.
firebase emulators:exec --only auth,database --project demo-takebase 'true'

# Bootstrap checks against the running emulators.
firebase emulators:exec --only auth,database --project demo-takebase 'node --test tests/firebase/bootstrap.test.ts'
```

The emulator RTDB namespace is `demo-takebase-default-rtdb`, e.g.
`http://127.0.0.1:9000/.json?ns=demo-takebase-default-rtdb`.

## Alias policy and remote boundaries

- `default` and `demo` both resolve to `demo-takebase`. A `demo-` project ID makes the CLI
  and SDKs refuse to contact real Firebase services, so accidental deploys fail safely.
- Do not add real project IDs, run `firebase login`, `firebase deploy`, create remote
  projects or databases, change billing, or download service-account keys without a
  separately approved remote wave that names the exact target.
- Keep private values in `firebase/.env` (git-ignored); only `firebase/.env.example` is tracked.
- Emulator logs (`*-debug.log`) and exported emulator state are git-ignored.
