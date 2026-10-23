# Takebase — Accepted Project Knowledge

Read `PROJECT_GUIDE.md` for verified project identity and workflow. This file contains durable, non-secret accepted knowledge only. Multica owns plans, task state, decisions, progress and verification evidence; do not mirror an issue or roadmap here.

## Accepted architectural direction

- Takebase (earlier called EdgeKit) is the framework described in its Multica project description.
- Takebase is TypeScript/Hono on Cloudflare Workers with independent D1 persistence per tenant, internal Drizzle schemas and Drizzle Kit migrations.
- Firebase Auth supplies global identity. The global Worker/D1 discovers tenants and memberships; the SDK routes to the selected tenant Worker.
- Collection authorization is typed, server-enforced and deny-by-default. The SDK is never an authorization boundary.
- D1 is authoritative. Firebase RTDB carries lightweight notifications, not complete records; an atomic tenant-D1 outbox supports asynchronous, retryable, at-least-once delivery and authorized refetch.
- Planned secrets use AES-256-GCM ciphertext in KV, tenant Worker keys, versioned rotation and external recovery escrow. Planned R2 backups do not replace encryption-key recovery or Firebase Auth exports.
- The SvelteKit admin uses the same SDK as applications. The framework and SDK are intended to publish independently.
- Optional Go services do not replace D1 as the source of truth. A future Bun/SQLite migration is a separate explicit decision.

These are accepted design intentions, not implemented or verified capabilities. Consult the current Multica description and selected issue for full requirements and changes.

## Memory boundaries

OpenCode may consult existing Jumbo memory narrowly if available, verifying historical information against current code and human decisions. Add durable knowledge only when requested or included in the agreed planning workflow. Never store secrets, customer data, raw conversations, full plans or temporary status here or in memory.

Claude Code treats this file as static guidance and never invokes Jumbo commands. Do not use Jumbo session, goal, work, worker, lifecycle or delegation commands. If Jumbo is absent, continue from repository evidence and Multica; do not install, initialize or repair it without separate authorization.
