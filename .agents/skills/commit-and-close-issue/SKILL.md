---
name: commit-and-close-issue
description: Handle approved Git/Gitea delivery and Multica closure in the same Claude Code session, recording exact-commit CI results and failures.
---

# Deliver and close in the same Claude Code session
Maintained source: Multica skill `ca91cc47-9f74-45f7-9ac2-54d4ad8afb7d`, retrieved 2026-10-19. Provider roles adapted locally: OpenCode plans; Claude Code implements and delivers.

The Claude Code session that implemented the selected issue owns its approved delivery and closure. Reuse its context; do not dispatch another agent, start a fresh planning/review session, create a wakeup, or schedule retries.

Read the issue and latest human instruction. Agree on the delivery scope once: local commit, target branch/remote, push, Gitea PR, required checks, and whether merge/closure are included. A combined human request can authorize several named steps without repeated approval between them. A Done-only request does not silently authorize push, PR, merge, or deployment; ask once for missing delivery authority and leave status unchanged unless the human requests a transition. A commit-only request does not authorize closing.

## Git and Gitea delivery

Inspect Git status and relevant diffs, confirm agreed scope and actual verification results, and stage only explicit task paths. Preserve unrelated staged/unstaged work and Multica's runtime AGENTS.md. Inspect staged changes for secrets without exposing values. Keep the configured Git identity, include the Multica issue key in the commit when useful, and verify the commit SHA. Never create an empty commit.
Takebase branch convention: commit on `feature/<ISSUE-KEY>-<short-description>` created from current `master` (for example `feature/SEGU-208-scaffold-workspace`), never directly on `master`. The exact Multica key in the branch name is how Gitea Actions results are mapped back to the issue. Every commit subject starts with the key: `<ISSUE-KEY>: <imperative summary>`. Never commit `reviews/`; the published review lives on the Multica issue. Push, PR and merge to `master` remain separately human-authorized.

For authorized remote delivery, resolve the existing Gitea repository and target branch before writing. Push only the approved branch; do not force-push or rewrite history without explicit authority. Create or update a PR only when requested, preserving unrelated content. Put the issue key in the PR and record repository, branch, full SHA, PR URL, and relevant run/check links in Multica. This mapping lets CI feedback identify the correct issue and candidate.

A rejected/failed push is a delivery failure, not successful completion. Record the concise error and keep/reopen the issue as Error if that existing status is available, otherwise Blocked, only when the human has authorized this failure-status handling. Otherwise leave status unchanged and request the transition. Do not assume Gitea will receive a webhook for a commit that never reached it. Stop for credentials, branch protection, unrelated history, or a decision requiring human action; do not bypass protections or run an unattended retry loop.

Read required Gitea checks for the exact pushed SHA, not a branch tip or a previous green commit. Record success, failure, pending, unavailable, or timed out honestly. Wait within the current session when practical; if checks remain pending, report with the SHA/run links and next human action, leaving status unchanged unless a transition was authorized. Do not launch an AI monitor. Each new pushed SHA needs its own results.

On terminal CI failure/error, record failing checks and evidence and keep/reopen the issue as Error when available, otherwise Blocked, only under human-authorized failure handling. Otherwise request that transition and leave status unchanged. The configured deterministic callback may do this without an AI session, but verify that mapping and status update exist before relying on it. Do not change CI/webhooks or enable an agent autopilot as part of delivery. Ignore stale results for superseded SHAs. Fixes remain in this session only within human-authorized scope; otherwise ask before changing code or retrying delivery.

## Done and acceptance

Start the approved delivery before marking Done. For an issue whose agreed completion includes Gitea delivery, require successful push and the required checks for that SHA, plus any explicitly required PR/merge and human acceptance. A passing build does not authorize merge or deployment. Missing or failing checks cannot be reported as passed.

A human can explicitly accept local-only completion or choose closure while remote checks are pending; record that exception and pending evidence without claiming verified remote delivery. Later failure for the accepted candidate must be reported and reopened under authorized failure handling rather than left as a misleading verified Done. Ask for the transition if not authorized.

Record acceptance and implementation/test/commit/PR/CI references in Multica, then move only the selected issue to Done when explicitly authorized. Close-only requests need no invented commit. No independent Checker receipt or OpenSpec fingerprint is required. Stop after this issue; do not push, merge, deploy, start another issue, or invoke another agent outside the agreed authority.

## Compact delivery evidence
Workflow version: 2026-10-11.

Reuse the selected issue's compact current-state brief and matching Wavelens baseline/evidence from implementation; do not begin a late baseline or repeat implementation planning. If the baseline is missing/mismatched, report it and agree retrospective scope before generating a review. Record only new relevant delivery checks, never reclassify historical/local evidence as exact-SHA CI. Refresh the review only if source or meaningful evidence changes; otherwise link the existing published snapshot or publish the existing unpublished snapshot. The normal last step for every wave is `wavelens preview --no-open --publish --repo <root>`, which writes the review and attaches that exact review and patch to the wave's Multica issue as one comment. Check scope, privacy and evidence before this combined generation/publication command; respect project data restrictions. A wave is not finished until its review is attached. Skip publication only when the human explicitly says not to publish. If preview already ran without --publish, or publication fails after generation, report the actual message and retry `wavelens publish --repo <root>` using the existing snapshot; do not regenerate or post the review by hand. Publication is idempotent; an already published review is not posted twice. Stop and report a persistent failure rather than looping. Publishing never changes issue status; do not change status as part of this review step. Wavelens owns its internal author/provider call; no separate review agent is needed. Separately human-authorized delivery/closure and failure handling are not part of publication. No separate agent, checker, scheduler, wakeup, AI monitor or next-wave execution. Deterministic CI callbacks remain separate. Commit/push/merge/deploy/closure authority and failure handling above are unchanged.

Reverify project/workspace/root from PROJECT_GUIDE.md and direct Multica CLI. No remote, branch or CI configuration was verified during bootstrap; do not assume one exists. Direct CLI recordkeeping is allowed without agents: read before updating, preserve unrelated content and verify saved results. Use supported stdin/file flags rather than wrappers concealing operations; never bypass protections. Claude Code reads JUMBO.md statically and never invokes Jumbo commands. Preserve root AGENTS.md as temporary runtime context, never durable guidance.
