---
name: plan-opencode-handoff
description: Plan one human-selected outcome with OpenCode and record a compact Claude Code handoff in Multica.
---

# Compact human-directed planning
Workflow version: 2026-10-11. Local provider-role adaptation: OpenCode plans; Claude Code implements and delivers.
Maintained source: Multica skill `5c023310-5ce6-4f1f-a74e-af64b783197c`, retrieved 2026-10-19.

Applies to the explicitly selected project. The human selects the outcome and starts the direct Claude Code session. Do not dispatch/assign agents, schedule runs, create wakeups, auto-start handoffs or advance another wave. No mandatory OpenSpec, review-agent chain or planning Markdown mirror.

Read the selected issue, bounded relevant decisions, PROJECT_GUIDE.md, applicable instructions and current affected code/tests. Use graph discovery and narrow source reads. Explain the understood goal and existing behavior before planning. Recommend defaults; ask only questions that change behavior, scope, compatibility or risk. Do not reopen accepted decisions or map the whole project unless requested.

Use the Multica CLI for the agreed plan. Preserve unrelated issue content. Keep one concise current-state section: accepted decisions, completed/remaining work, actual evidence and the next human action. Keep historical discussion in existing comments; read it on demand rather than copying it into each prompt. Jumbo holds accepted durable knowledge, not task state; Claude Code reads JUMBO.md but does not invoke its CLI. Root AGENTS.md is Multica's temporary runtime brief; never replace it with durable guidance.

## Compact handoff
Write the same short execution brief in the issue and any human-requested staged Claude Code prompt. Reference the issue for detailed history; do not repeat the whole plan. Use real Markdown bullets, one path per nested bullet, inline code and blank lines before lists. Include:

- Issue key, workspace/profile, project, absolute repository root, component working directory and agreed wave label.
- Goal: one demonstrable outcome and observable acceptance.
- Accepted decisions and current progress: only what changes execution; unresolved decisions if any.
- Read first: exact relevant paths/symbols with short reasons, in reading order.
- Change/Create: allowed paths and intended behavior; mark new paths as proposed.
- Checks: actual commands, working directories, prerequisites and expected observations.
- Boundaries: exclusions, existing edits to preserve and permissions not granted.
- Preflight/review: the explicit obligations below, with actual issue/root/profile/workspace values filled in.
- Stop: human review after this issue; no automatic agents, another task, Git delivery, deployment or Done.

Omit empty groups. Keep correctness-relevant dependencies; a compact map is not permission to ignore callers or runtime wiring. Narrow dependency reads are allowed; material scope changes need a human decision.

## Required Wavelens preflight in every implementation handoff
Before edits, Claude Code loads the current workspace execute-approved-plan skill once using the authenticated Multica CLI (resolve by name, then skill get with --with-content). Include its ID and this workflow version when verified; stale local copies do not override the explicit handoff. Reconcile the maintained provider-neutral safeguards with this project's explicit Claude Code role and human-only status-transition rule. Do not reload all skills each turn. If unavailable, report the prerequisite rather than silently using an old workflow.

Include these commands with concrete identities in the emitted prompt:
- wavelens status --repo <absolute-root>
- If no active wave: wavelens begin <issue-key> --repo <absolute-root> --wave <label> --profile <profile> --workspace-id <workspace-id>
- Recheck status after begin and verify the stored wave belongs to this exact repository, issue and workspace, with a recorded pre-edit baseline. Resume only a matching wave. Stop before source edits if tooling, identity, baseline or authorization cannot be established; record the blocker. Never replace another wave automatically.
- Capture the current dirty tree before edits, so previous waves and existing work stay excluded. If this issue already has unrecorded edits, stop to agree a retrospective baseline; beginning now cannot attribute them correctly.
- Run required checks once through wavelens record --repo <root> --scope local -- <command> [args...] from their actual working directories. Use mocked/remote scope only for actual corresponding evidence. Rerun when relevant source/configuration/environment changes or a failed check needs confirmation, not merely to collect another report.
- At handoff: The normal last step for every wave is `wavelens preview --no-open --publish --repo <root>`, which writes the review and attaches that exact review and patch to the wave's Multica issue as one comment. Check scope, privacy and evidence before this combined generation/publication command; respect project data restrictions. A wave is not finished until its review is attached. Skip publication only when the human explicitly says not to publish. If preview already ran without --publish, or publication fails after generation, report the actual message and retry `wavelens publish --repo <root>` using the existing snapshot; do not regenerate or post the review by hand. Publication is idempotent; an already published review is not posted twice. Stop and report a persistent failure rather than looping. Publishing never changes issue status; do not change status as part of this review step. Wavelens owns its internal author/provider call; no separate review agent is needed. Link the published review or concrete blocker. Regenerate only after materially changed source/evidence.

Before presenting/staging, check that this brief includes exact identity, acceptance, focused file map, checks, pre-edit Wavelens baseline and review publication. Replace placeholders; do not merely say "use the skill". Refresh existing staged prompts only when human-selected; a workspace skill update does not synchronize local files or existing chats. Planning itself does not run Wavelens, implement or dispatch a session.

## Takebase identity and platform safeguards

Read and reverify PROJECT_GUIDE.md. Expected project Takebase: `6f84dfa1-a433-4994-bcc1-9a79819f297f`; workspace `237ef0f7-262b-4830-9d1a-c86b40b59fda`; root `/Volumes/Workspace/dev-drakecall/node/takebase`. Resolve the current profile, selected issue and wave; none is implicitly selected by this skill. No application components or verified application commands existed at bootstrap; planned paths are not implemented paths.

Gather the selected wave's issues, sub-issues, latest comments, accepted plan and decisions through direct Multica CLI reads before mapping code. Direct CLI recordkeeping is allowed without agent dispatch; read before writing, preserve unrelated content and read back saved results. Prefer supported file/stdin flags over interpreter wrappers. Never bypass safety protections or save placeholder descriptions.

Preserve official platform layouts, entry points and build/test/deploy mechanisms. Reinitialization, generated-config replacement, ad-hoc parallel tooling or structural departures need human approval. Use official generators only for authorized scaffolding. Carry PROJECT_GUIDE.md/CLAUDE.md's conditional Worker conventions into relevant handoffs: arrow functions with platform class-method exceptions, one export point/composition root, typed AsyncLocalStorage scopes, no mutable production request data at module scope, and independent scopes for cron/queue/Workflow/RPC execution. Discover actual roots first; do not invent component paths or alter compatibility flags during planning.

Require a progress comment and review publication at every agreed section checkpoint and full wave, leaving status unchanged unless separately requested. Stop for human review at each agreed boundary.
