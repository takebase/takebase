---
name: execute-approved-plan
description: Implement one human-selected Multica issue with Claude Code, Wavelens preflight, focused verification and human review.
---

# Direct implementation
Workflow version: 2026-10-11. Local provider-role adaptation: OpenCode plans; Claude Code implements and delivers.
Maintained source: Multica skill `fc160997-2017-423c-8d68-13f4eb565c67`, retrieved 2026-10-19.

Start only on the human's implementation request for this issue. Status, a plan or another agent's comment is not approval. Read the compact issue handoff and relevant decisions, PROJECT_GUIDE.md, applicable instructions and focused code/tests. Prefer graph discovery. Explain contradictions and ask before material behavior/scope/authority changes. Preserve unrelated edits and Multica's ephemeral root AGENTS.md.

## Preflight — before source edits
- Resolve the exact issue UUID/key, workspace/profile, project, local repository root and wave label. Inspect Git status and existing work.
- Run wavelens status --repo <root>. If no active wave, run wavelens begin <issue-key> --repo <root> --wave <label> --profile <profile> --workspace-id <workspace-id>, then recheck status.
- Verify active wave metadata matches this root, issue UUID and workspace, and records the baseline before these edits. Resume a matching wave; never --replace a different wave without approval.
- Default begin captures HEAD plus the existing dirty tree, excluding prior-wave/unrelated edits. If this issue's edits already exist without a baseline, stop and agree a retrospective scope; do not treat begin-after-edit as a complete review.
- If tooling/authentication, workspace identity, baseline or applicable data permission is missing, report it on this issue and stop before edits. Do not install tools, change providers, alter Git history or bypass protections to satisfy preflight.

A matching pre-edit baseline is required, not an optional handoff reminder. These skill instructions are not a filesystem edit hook; do not claim mechanically enforced protection exists.

## Implement and verify
Move the selected issue to Building/In Progress only when the human explicitly requests that status transition, with no agent dispatch. Implementation approval alone does not authorize a status change. This resolves the maintained skill's automatic-transition wording in favor of the bootstrap contract's explicit human authority rule.

Use the handoff file map as starting context; read narrow dependencies when callers/imports/runtime contracts expose a gap. Do not remap unrelated directories or repeat accepted planning research. Keep a small clear diff; no speculative adjacent refactoring.

Run the agreed behavior checks through wavelens record --repo <root> --scope local -- <command> [args...] in the command's actual working directory. Preserve nonzero exits. Use focused checks and justified broader regression tests. Record commands/results against the actual source; unavailable checks are not passed. Reuse successful evidence only when relevant source/config/environment is unchanged; rerun after relevant changes or to verify a failure fix. Do not repeat tests solely for reports.

Use mocked/remote scope only for real matching evidence. Wavelens observe is reported observation, not executed tests or exact-SHA CI proof. Output capture stays off unless safe to retain; never collect credentials or real OTP/email payloads.

## Review and stop
Compare behavior with acceptance. The normal last step for every wave is `wavelens preview --no-open --publish --repo <root>`, which writes the review and attaches that exact review and patch to the wave's Multica issue as one comment. Check scope, privacy and evidence before this combined generation/publication command; respect project data restrictions. A wave is not finished until its review is attached. Skip publication only when the human explicitly says not to publish. If preview already ran without --publish, or publication fails after generation, report the actual message and retry `wavelens publish --repo <root>` using the existing snapshot; do not regenerate or post the review by hand. Publication is idempotent; an already published review is not posted twice. Stop and report a persistent failure rather than looping. Publishing never changes issue status; do not change status as part of this review step. Wavelens owns its internal author/provider call; no separate review agent is needed. Preserve the wave on failure; never fabricate success. Regenerate only after material source/evidence changes.

Post one concise current-state update: changes, actual check results, exact review link or blocker, remaining work and next human action. Leave status unchanged when attaching the review; status transitions require a separate human request. Report readiness, unfinished work and concrete prerequisites in the update. Distinguish historical, local, mocked, reported and exact-commit remote evidence. Do not produce mirrored planning/review Markdown or reread whole skills/histories each turn.

Stop after this issue. No agent assignment/dispatch, wakeups, schedules, automatic follow-up, next-wave selection or Jumbo orchestration. No commit/push/merge/deployment/Done without corresponding human authority. For approved delivery, use commit-and-close-issue in this same session; no automatic checker or monitor.

## Takebase identity, recordkeeping and platform conventions

Reverify the human-named project via direct Multica CLI and its attached directory. Expected Takebase ID: `6f84dfa1-a433-4994-bcc1-9a79819f297f`; workspace `237ef0f7-262b-4830-9d1a-c86b40b59fda`; root `/Volumes/Workspace/dev-drakecall/node/takebase`. Resolve profile/issue/wave each time. Gather selected issues/sub-issues, comments, handoff and decisions before code mapping. No application components or verified application commands existed at bootstrap. Proposed EdgeKit paths/commands are not evidence of implementation.

Direct CLI project/issue work is permitted within human scope without dispatch. Read current content, preserve unrelated content, verify saved results, use supported file/stdin flags for long content and avoid wrappers concealing CLI calls. Never bypass safety protections or write placeholder descriptions.

Use CodeGraph when indexed and codebase-memory-mcp for code discovery; direct reads/text search cover configurations, documentation and graph gaps. Preserve platform-native component layout, entry points, config, generation, build/run/test/deploy commands. Reinitialization, overwriting generated configuration or departing from established structure requires explicit approval; authorized scaffolding uses official generators.

For Worker components, discover actual roots and Wrangler mains; obey PROJECT_GUIDE.md and CLAUDE.md: arrow functions with required platform class methods delegating to arrows; one central export point and `createContext(env, request?)` composition root; typed AsyncLocalStorage request store with `nodejs_als`, `runInRequest`, `useContext` and typed request locals; throw outside a scope; never module-scope mutable production user/tenant/session/request state; independent scopes for cron/queue/Workflow/RPC entrypoints. Read current platform docs/config before compatibility changes; report conflicts rather than broadly migrating code.

At every human-agreed section checkpoint and full wave, post changes, passed/failed/unavailable checks and remaining work, publish the exact review/patch as above and stop for human review. Leave status unchanged unless expressly requested. Claude Code never invokes Jumbo commands. Root AGENTS.md is never created, edited, deleted, restored, staged or committed as durable guidance.
