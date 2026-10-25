# Takebase — Accepted Project Knowledge

Read `PROJECT_GUIDE.md` for verified project identity and workflow. This file contains durable, non-secret accepted knowledge only. Multica owns plans, task state, decisions, progress and verification evidence; do not mirror an issue or roadmap here.

## Accepted architectural direction

- Takebase (earlier called EdgeKit) is the framework described in its Multica project description.
- Takebase is TypeScript/Hono on Cloudflare Workers with independent D1 persistence per tenant, internal Drizzle schemas and Drizzle Kit migrations.
- Firebase Auth supplies global identity. The global Worker/D1 discovers tenants and memberships; the SDK routes to the selected tenant Worker.
- Collection authorization is typed, server-enforced and deny-by-default. The SDK is never an authorization boundary.
- Validation follows Laravel's conventions, which the human finds intuitive (accepted 2026-10-23, SEGU-210). Takebase has its own rule engine, not Zod:
  - Rules: rule strings such as `required|string|max:200`, plus `unique` and `exists` database rules.
  - Errors: a 422 response with one message per field.
  - Messages: a replaceable catalog with `:attribute` placeholders, so translations can be added later.
  - Database structure: Drizzle schemas with Laravel-like `id()`/`timestamps()` helpers. Database constraints remain the final guard against races.
  - Future request validation outside collections should copy Laravel's FormRequest style: a declared rule set per endpoint, validated before the handler runs.
- D1 is authoritative. Firebase RTDB carries lightweight notifications, not complete records; an atomic tenant-D1 outbox supports asynchronous, retryable, at-least-once delivery and authorized refetch.
- Realtime (accepted 2026-10-24, SEGU-216):
  - Adapters are independent of core. Core owns only the `RealtimeAdapter` operations (`publish`, `grant`, `revoke`, `revokeAll`); Firebase code lives in `@takebase/adapter-firebase` and the standalone `@takebase/firebase-rtdb` client (SEGU-241).
  - RTDB is only a trigger: one database per tenant holds collection revisions, grants and presence. Data access is always decided by the PocketBase-style collection rules in the API, followed by a refetch.
  - The Worker writes as a per-tenant dispatcher user (email/password), so the database rules bind it too. No Admin SDK or service accounts. RTDB is Worker-written only; wider client access needs an explicit adapter extension.
  - Dispatch runs after each committed write and on session open, never on per-tenant crons (the account-wide Cron Trigger limit would cap tenants).
  - Grants and revocations are versioned with global D1's `tenants.access_revision` (maintained by triggers), and the rules reject any grant not newer than the latest revocation.
  - On revocation the SDK signs the user out fully and wipes local state, even with other tenants (SEGU-217). That is UX; enforcement is the rules plus the per-request membership check.
- Planned secrets use AES-256-GCM ciphertext in KV, tenant Worker keys, versioned rotation and external recovery escrow. Planned R2 backups do not replace encryption-key recovery or Firebase Auth exports.
- The SvelteKit admin uses the same SDK as applications. The framework and SDK are intended to publish independently.
- Optional Go services do not replace D1 as the source of truth. A future Bun/SQLite migration is a separate explicit decision.

These are accepted design intentions, not implemented or verified capabilities. Consult the current Multica description and selected issue for full requirements and changes.

## Memory boundaries

OpenCode may consult existing Jumbo memory narrowly if available, verifying historical information against current code and human decisions. Add durable knowledge only when requested or included in the agreed planning workflow. Never store secrets, customer data, raw conversations, full plans or temporary status here or in memory.

Claude Code treats this file as static guidance and never invokes Jumbo commands. Do not use Jumbo session, goal, work, worker, lifecycle or delegation commands. If Jumbo is absent, continue from repository evidence and Multica; do not install, initialize or repair it without separate authorization.
