# Takebase measurements

Measurements from SEGU-229, recorded on 2026-10-31 and 2026-11-01. They describe this code on these targets and are not performance budgets or production promises. Raw results are in `results/local.json` and `results/staging.json`.

## Running them

| Command | What it does |
|---|---|
| `pnpm benchmark:local` | Against a running `pnpm dev:stack`; writes `results/local.json` |
| `pnpm benchmark:quick` | The same at a small size; writes nothing |
| `pnpm staging:benchmark` | `takebase-staging-tenant-a` only; stops itself at 200 Worker requests. Needs the operator's approval each time |
| `pnpm spike:native` | The collection contract on Bun and SQLite (needs Bun, which CI does not use) |
| `pnpm smoke:performance` | Static checks, the native spike and the quick benchmark. Run it with no stack up |

Records are numbered `BENCH-*` and each run removes its own. Their outbox rows stay until normal retention removes them, because deleting the newest would leave `max(seq)` behind the realtime revision and provisioning would report stale signals.

## Method

All latency is measured at the client, with plain `fetch`, as tenant-a's `alice` (an agent). Percentiles use the nearest rank, and failed requests are counted as errors, not as latency. Requests run one fixed-size batch after another; this is not a sustained load test.

## Local results

Local workerd and SQLite with the Auth and RTDB emulators, on an Apple M4 with 32 GiB, macOS (Darwin 25.6), Node 24.21 and Wrangler 4.151.3. **This is not Cloudflare latency.** The local stack also trusts unsigned emulator tokens, so these figures leave out signature checks. 3,625 Worker requests, 0 errors.

| Operation | Clients | Requests | p50 ms | p95 ms | p99 ms | max ms | req/s |
|---|---:|---:|---:|---:|---:|---:|---:|
| Liveness (no auth, one D1 read) | 1 | 200 | 1.7 | 2.6 | 3.3 | 13.1 | 535 |
| Invalid token refused | 1 | 200 | 1.8 | 2.6 | 8.7 | 46.3 | 465 |
| Create | 1 | 200 | 8.1 | 11.3 | 22.7 | 39.3 | 114 |
| View | 1 | 200 | 3.4 | 4.9 | 26.9 | 31.1 | 242 |
| Update | 1 | 200 | 7.2 | 9.7 | 27.0 | 30.2 | 126 |
| Liveness (no auth, one D1 read) | 8 | 200 | 6.2 | 16.3 | 30.9 | 31.1 | 1,020 |
| Invalid token refused | 8 | 200 | 6.9 | 31.5 | 33.5 | 34.3 | 881 |
| Create | 8 | 200 | 37.5 | 59.8 | 70.8 | 71.6 | 204 |
| View | 8 | 200 | 15.2 | 37.6 | 55.8 | 56.8 | 447 |
| Update | 8 | 200 | 36.6 | 73.5 | 81.9 | 103.0 | 194 |
| List, default order, 1,000 rows | 1 | 100 | 3.8 | 6.2 | 31.5 | 35.2 | 214 |
| List, default order, 10,000 rows | 1 | 100 | 6.4 | 8.0 | 57.4 | 77.7 | 128 |
| List, filter and sort, 10,000 rows | 1 | 100 | 5.4 | 6.9 | 38.2 | 39.2 | 161 |
| List, range filter, 10,000 rows | 1 | 100 | 4.2 | 7.8 | 31.7 | 35.4 | 187 |
| List, deepest page, 10,000 rows | 1 | 100 | 11.1 | 12.5 | 44.1 | 44.2 | 83 |
| List, deepest page, 10,000 rows | 8 | 100 | 72.3 | 118.6 | 126.4 | 135.2 | 104 |

`results/local.json` has every combination, including 1,000 rows and 8 clients.

| Other measurement | Result |
|---|---|
| Write to realtime signal visible (20 samples) | p50 30 ms, max 45 ms |
| One delivery run, 1,000 pending events | 71 ms; all delivered |
| Tenant Worker bundle | 350,249 bytes (76,717 gzip) |
| Global Worker bundle | 309,862 bytes (66,611 gzip) |
| Startup profile, tenant and global (`wrangler check startup`, local) | 13.8 ms and 12.4 ms |
| Memory of all local workerd processes after the run | 1,656 MiB across 7 processes |

The delivery run publishes one revision per collection, so its rate says little about many collections or a slow provider.

## Staging results

`takebase-staging-tenant-a` as deployed, measured from this one machine on 2026-11-01, with real Firebase tokens and Google signature checks in the global Worker. 140 Worker requests, 0 errors. The table had 67 rows during the list queries.

**These samples are small, 6 to 10 requests per row, so p95 and p99 are in effect the maximum.** The figures include this machine's network path and vary with its distance from Cloudflare and with where D1 runs. Liveness is the nearest thing here to a network floor.

| Operation | Clients | Requests | p50 ms | max ms |
|---|---:|---:|---:|---:|
| Liveness (no auth, one D1 read) | 1 | 6 | 64.5 | 69.9 |
| Invalid token refused | 1 | 6 | 55.1 | 106.1 |
| Create | 1 | 10 | 122.3 | 210.0 |
| View | 1 | 10 | 65.0 | 90.5 |
| Update | 1 | 10 | 87.1 | 116.3 |
| List, default order | 1 | 6 | 65.5 | 72.1 |
| List, filter and sort | 1 | 6 | 63.6 | 71.5 |
| List, deepest page | 1 | 6 | 64.5 | 70.1 |
| Liveness (no auth, one D1 read) | 4 | 6 | 39.6 | 129.8 |
| Create | 4 | 10 | 128.5 | 212.1 |
| View | 4 | 10 | 73.2 | 127.7 |
| Update | 4 | 10 | 88.2 | 122.7 |
| List, default order | 4 | 6 | 62.0 | 93.0 |

Write to realtime signal visible on real Firebase: p50 313 ms, max 479 ms (5 samples).

**Not measured on Cloudflare:** Worker CPU time, memory, startup time, D1 rows read, sustained load, and behaviour with 1,000 or 10,000 rows. The staging run added no fixture rows.

## What the numbers suggest

- **Nothing here justifies an optimization yet.** No operation showed errors, and nothing has been changed because of these runs.
- **The deepest page is the slowest list.** At 10,000 rows it takes nearly twice as long as the default order locally, and 72 ms with 8 clients. `policies` has no index on `created`, `status` or `premium`, and each list also counts its rows. Measure rows read on real D1 before adding indexes.
- **Concurrent writes queue.** Create goes from 8 ms to 38 ms locally with 8 clients. Cloudflare documents the same shape: each D1 database runs one query at a time.
- **A failing first cleanup query, twice.** In both staging runs the first D1 query after the benchmark failed with Cloudflare API error 7403, and a later try worked. The cause is unknown. The first run's cleanup did not retry and lost its results; cleanup now tries three times.

## Provider limits

Read from the provider docs on 2026-11-01; check them again before relying on any of them.

| Limit | Free | Paid |
|---|---:|---:|
| [D1](https://developers.cloudflare.com/d1/platform/limits/) database size | 500 MB | 10 GB |
| D1 queries per Worker invocation (a batch counts as one) | 50 | 1,000 |
| D1 databases per account | 10 | 1,000,000 |
| D1 bound parameters per query | 100 | 100 |
| D1 string, BLOB or row size | 2 MB | 2 MB |
| D1 query duration | 30 s | 30 s |
| D1 concurrency, per database | one query at a time; a full queue answers "overloaded" | same |
| [Worker](https://developers.cloudflare.com/workers/platform/limits/) CPU per HTTP request | 10 ms | 30 s default, up to 5 min |
| Worker memory per isolate | 128 MB | 128 MB |
| Worker size, uncompressed | 64 MiB | 64 MiB |
| Worker startup | 1 s | 1 s |
| Worker subrequests per request | 50 | 10,000 |
| Cron Triggers per account | 5 | 250 |
| [Rate limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) | per location, approximate; period 10 or 60 s; namespace shared across the account | same |

[Firebase Realtime Database](https://firebase.google.com/docs/database/usage/limits): 200,000 simultaneous connections per database (100 on Spark), about 1,000 writes per second per database (not a hard cap), and 256 MB per REST write.

Takebase's own limits: a 1 MiB request body and 60 requests per minute per address on the delivery and redemption routes. The Free plan's 10 ms CPU and 10 databases are the ones to check first against a real deployment, because each tenant has its own D1 database, and CPU time was not measured here.

## Migrations

`tests/migrations/upgrade-compatibility.test.ts` applies every tenant and global migration in order on SQLite, with rows written after the first. The rows survive, and the invariants hold on them. On local D1 and on native SQLite, the shared scenario also upgrades a database that already holds a record. No upgrade ran on real D1 in this wave: staging had no pending migrations.

## Native spike

**A feasibility check, not a supported product.** `examples/native-spike` runs the shared scenario on Bun 1.3.10 and SQLite 3.51.0, in memory. It reads no D1 data, and D1 stays the source of truth. `examples/workers/tenant/test/portability-contract.ts` is the scenario; on local D1 it runs in `pnpm test`.

Core needed no change: everything here reaches the database through `AnyD1Database`, implemented by `examples/native-spike/src/sqlite-adapter.ts` in about 60 lines. The scenario passes on both, covering migrations, tokens and rules, create, view and update, validation, lists, database constraints, write and event atomicity, and overlapping requests.

Differences found or known:

| Difference | D1 | Native spike |
|---|---|---|
| The database aborts a write (seen with a trigger) | 409 | **500.** Both refuse and roll back. Core's `isConstraintError` matches D1's wording. A real unique-index race should behave the same way (inferred, not run) |
| Foreign keys | always enforced | off in SQLite until the spike's `PRAGMA foreign_keys = ON` |
| `meta` on results | duration, rows read and written, and more | only `changes` and `last_row_id` |
| Durability and scale | managed, with Time Travel | one in-memory database in one process; concurrent writers across processes not tested |
| Identity | real membership check through the global Worker | stand-in verifier; no real tokens |
| Firebase, KV, service bindings, secrets, backups | available | not present and not attempted |

The issue's proposed `packages/framework` seam was not needed. Go services and any real D1-to-SQLite migration remain out of scope.
