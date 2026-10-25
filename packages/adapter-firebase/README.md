# `@takebase/adapter-firebase`

Takebase's realtime adapter for Firebase Realtime Database: an implementation of core's `RealtimeAdapter` (`publish`, `grant`, `revoke`, `revokeAll`) plus the Database Security Rules that enforce it. Core never sees Firebase paths, ETags or rules.

## Layout (one database per tenant)

| Path | Written by | Read by |
| --- | --- | --- |
| `/collections/{name} = { revision }` | the dispatcher; a revision never decreases | members |
| `/access/members/{uid} = { rev }` | the dispatcher; the user may only delete their own | that user |
| `/access/revoked/{uid}`, `/access/revoked/_tenant` | the dispatcher; never decrease | nobody but the dispatcher |
| `/presence/{uid} = { online, lastSeen }` | that member, with `lastSeen` = server time | members |

Everything else is denied. A grant is accepted only when its `rev` is newer than the user's and the tenant's last revocation. Revocations are one atomic update under `/access`, so a grant read before a removal can never undo it.

## Usage

```ts
import { databaseRules, firebaseRealtime } from "@takebase/adapter-firebase";

// In the tenant Worker's createContext, with the dispatcher's secrets:
const realtime = firebaseRealtime({ databaseURL, apiKey, email, password });

// Rendered once per tenant with its dispatcher user's uid (letters and digits only).
// `@takebase/adapter-firebase/rules` exports the same function with no dependencies.
const rules = databaseRules(dispatcherUid);
```

The dispatcher is an ordinary email/password user, so the rules apply to the Worker too. There is no Admin SDK or service account. With the local emulator it signs in through the Auth emulator; the emulator's admin token is never used. All tenant members can see collection names, revisions and presence. The collection rules in the API decide data access.

## Tests

- `pnpm --filter @takebase/adapter-firebase test`: adapter ordering logic with a scripted database.
- `pnpm test:realtime` (repository root): the rendered rules against the real emulators, plus the tenant Worker end to end.
