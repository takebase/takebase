---
name: multica-harness-flow
description: Keep Multica as the human-directed plan and Kanban record with compact OpenCode-to-Claude Code handoffs and Wavelens preflight.
---

# Workspace workflow
Workflow version: 2026-10-11. Local provider-role adaptation: OpenCode plans; Claude Code implements and delivers.
Maintained source: Multica skill `026e4d7b-2b70-4d1d-9613-cc7bec04ce90`, retrieved 2026-10-19.

The human plans interactively with OpenCode, selects one outcome and starts Claude Code directly. Multica holds the current plan, decisions, progress and actual evidence. No automatic agents: do not assign/dispatch agents, schedule runs, create wakeups, auto-start handoffs, monitor with AI or advance another wave. Deterministic CI/reporting is not an AI agent and remains separate.

Use plan-opencode-handoff for a compact execution brief, execute-approved-plan for authorized implementation and commit-and-close-issue for separately approved delivery in the same session. No mandatory OpenSpec, checker/reviewer chain, fingerprints or duplicate Markdown plans.

Read the selected issue and bounded relevant comments; preserve accepted decisions and unrelated content. Maintain one short current-state section and load historical context only when needed. PROJECT_GUIDE.md/local technical guidance is durable; root AGENTS.md is a Multica-owned temporary brief, never edited for durable rules. Jumbo stores accepted knowledge; Claude Code reads JUMBO.md without invoking its CLI.

Before edits, the implementing session must verify issue/repository/workspace identity and a matching Wavelens pre-edit baseline using status/begin/status. Stop before edits on missing/mismatched baseline; never replace another wave automatically or attribute pre-existing work to this wave. Every staged prompt must explicitly include this preflight, check recording and preview/publication; local skill copies and old chats do not auto-sync.

Record required checks through Wavelens once for the relevant source/environment. The normal last step for every wave is `wavelens preview --no-open --publish --repo <root>`, which writes the review and attaches that exact review and patch to the wave's Multica issue as one comment. Check scope, privacy and evidence before this combined generation/publication command; respect project data restrictions. A wave is not finished until its review is attached. Skip publication only when the human explicitly says not to publish. If preview already ran without --publish, or publication fails after generation, report the actual message and retry `wavelens publish --repo <root>` using the existing snapshot; do not regenerate or post the review by hand. Publication is idempotent; an already published review is not posted twice. Stop and report a persistent failure rather than looping. Publishing never changes issue status; do not change status as part of this review step. Wavelens owns its internal author/provider call; no separate review agent is needed. Link the review or its actual blocker. No autonomous review agent or Done transition. Do not load all skills/whole plans or rerun green checks each turn.

Statuses describe work, not authorization:
- Todo/Backlog: waiting for human selection.
- Planning: active OpenCode conversation; Awaiting Approval: agreed plan awaiting selection.
- Building/In Progress: selected implementation; In Review: ready for human inspection.
- Error when available, otherwise Blocked: failed push/required CI or concrete prerequisite.
- Done: acceptance criteria met and, for code, the PR to `master` merged after exact-SHA CI passed (In Review while the PR is open); record any explicitly accepted exception honestly.

Use the authenticated Multica CLI with resolved workspace/project/issue; JSON and bounded reads. Long descriptions/comments use temporary UTF-8 transport files, not planning artifacts. If stale repository runtime context blocks record operations, use a neutral directory with explicit existing profile/workspace; do not delete runtime metadata. Local source work stays in the selected repository. Do not edit unrelated issues or silently broaden permissions.

## Takebase bootstrap contract

If the human has not named the project, ask and wait. Read active workspace/project/resources and verify the attached path; expected identity is Takebase `6f84dfa1-a433-4994-bcc1-9a79819f297f`, workspace `237ef0f7-262b-4830-9d1a-c86b40b59fda`, root `/Volumes/Workspace/dev-drakecall/node/takebase`. Resolve the profile and selected issue/wave rather than assuming examples. Gather selected issues/sub-issues, latest comments, handoff, accepted plan and decisions before graph-mapping relevant code. No component directories or application commands were verified at bootstrap; future structure requires authorized work.

Direct CLI recordkeeping is allowed; no-dispatch rules prohibit additional AI runs, not approved descriptions/plans/progress updates. Read existing content, preserve unrelated content, verify saved results, use installed `--help` and supported stdin/file flags, and prefer direct commands over interpreter wrappers. Project update currently uses `--description`. Investigate safety rejections with available diagnostics; never disable protections, hide rejections or change authentication to bypass a restriction. Never save placeholder descriptions.

Use CodeGraph when indexed and codebase-memory-mcp for code discovery; text/direct reads are fallbacks for configs/docs and graph gaps. Keep official platform structure and verified commands; ask before reinit, generated-config replacement or structural departures. Use official generators for authorized scaffolding only. For actual Worker components, follow PROJECT_GUIDE.md/CLAUDE.md's arrow-function/platform-method, central-export/composition-root, typed AsyncLocalStorage request-scope and mutable-state isolation conventions; never assume a Worker root or silently migrate code/config.

At each human-agreed section checkpoint and full wave, publish the exact review/patch and post changes, passed/failed/unavailable checks and remaining work. Stop for human review. The human's request to plan or implement the selected issue authorizes its routine transitions under the PROJECT_GUIDE.md lifecycle; verify each saved update. Publication never changes status. No next-wave execution, delivery or closure without corresponding authority. Root AGENTS.md remains temporary; never create/edit/delete/restore/stage/commit it as durable guidance.
