---
name: project-memory
description: Use Jumbo as OpenCode's accepted project knowledge, with Multica as the task and progress record and Claude Code reading static guidance.
---

# OpenCode project memory
Maintained source: Multica skill `2540b399-c80b-44a4-b734-8b3c70dce8f2`, retrieved 2026-10-19. Provider roles adapted locally: OpenCode plans; Claude Code implements and delivers.

OpenCode may search existing Jumbo memory for accepted architecture decisions, invariants, components, dependencies, and reusable guidelines. Verify historical information against current code and human decisions. Use narrow searches rather than full memory dumps.

Capture accepted durable knowledge only when the human requests it or the agreed planning workflow includes it. Link the relevant Multica issue. Update an existing matching record rather than duplicating it. Do not store full plans, raw conversations, temporary task status, secrets, credentials, or customer-sensitive data.

Multica holds current plans, decisions, progress, and check results. Jumbo is not a roadmap or task scheduler. Do not run its session, goal, work, worker, or delegation lifecycle commands.

If Jumbo is absent or unhealthy, continue from repository evidence and Multica. Do not install, initialize, or repair it without a setup request explicitly authorizing that operation; the Takebase bootstrap does not authorize Jumbo initialization. Claude Code treats JUMBO.md as static guidance and never runs Jumbo commands.

Read PROJECT_GUIDE.md and reverify the human-named project/workspace/root through the CLI before project recordkeeping. The Takebase root is `/Volumes/Workspace/dev-drakecall/node/takebase`; project `6f84dfa1-a433-4994-bcc1-9a79819f297f`; workspace `237ef0f7-262b-4830-9d1a-c86b40b59fda`. Stored identity does not select a wave or authorize work. Direct Multica recordkeeping is permitted within the human's scope, without dispatch: preserve unrelated content and verify saved results. Never treat planned EdgeKit components or CLI commands as verified implementations.
