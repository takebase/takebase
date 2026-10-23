# Takebase Project Guide

## Project identity

- Multica project: **Takebase** (`6f84dfa1-a433-4994-bcc1-9a79819f297f`).
- Workspace: **Segutrends** (`237ef0f7-262b-4830-9d1a-c86b40b59fda`).
- Attached local project root: `/Volumes/Workspace/dev-drakecall/node/takebase`.
- Product: **Takebase**, a Cloudflare-native, PocketBase-inspired backend framework. Project and product share the name (npm scope `@takebase`, repository `takebase/takebase`). Older text calling it EdgeKit refers to the same product.
- Bootstrap audit: **SEGU-206**. Existing product umbrella: **SEGU-205**. Neither selects or authorizes an implementation wave.
- CLI reads during bootstrap used the existing default profile with no profile override. Resolve the actual profile for each implementation handoff; never invent a profile name.

Verify stored identity against the authenticated Multica CLI and the current folder before work. If the human has not named the current project, ask which project to use. Read the active workspace, named project and attached resources; stop if the local directory is missing, inaccessible, ambiguous or mismatched. Never reuse another project's identity.

## Read order and roles

1. `PROJECT_GUIDE.md`, then `JUMBO.md`.
2. Applicable component instructions and the local skill for the requested work.
3. The human-selected Multica issue, relevant sub-issues, latest comments, compact handoff, accepted plan and decisions.
4. Relevant configuration and graph-discovered code/tests, once application components exist.

OpenCode plans interactively; the human starts Claude Code to implement the selected issue. Multica records accepted plans, current task state, decisions, progress and evidence. Jumbo holds accepted durable knowledge, not task state. Claude Code reads `JUMBO.md` but never invokes Jumbo commands. No agents, squads, schedules, wakeups, autopilots or automatic follow-up.

Use `.agents/skills/plan-opencode-handoff/SKILL.md` for planning, `execute-approved-plan/SKILL.md` before implementation, `multica-harness-flow/SKILL.md` for recordkeeping, `project-memory/SKILL.md` for durable knowledge, and `commit-and-close-issue/SKILL.md` only after separate delivery authorization.

## Direct Multica CLI access

The current OpenCode or Claude session may use direct `multica` commands for the human's requested project/issue work: reading context, updating descriptions and accepted plans, approved issue creation/updates and progress comments. No-agent rules do not prohibit recordkeeping. Read existing content, preserve unrelated work and read back saved results. Never save placeholder examples as actual descriptions.

Use the installed CLI's `--help` contract. Prefer direct CLI arguments and supported file/stdin flags for long issue descriptions/comments; `project update` currently supports `--description`. Avoid interpreter wrappers concealing CLI operations. If a command is blocked, inspect its actual reason and use available safety diagnostics for a clearer direct command. Never disable secret protections, hide a rejected operation or change authentication to bypass restrictions.

## Repository evidence and platform structure

At bootstrap on 2026-10-19, this folder contained only `.codegraph/`. There was no Git repository, HEAD, package manifest, README, application component, component `AGENTS.md`, existing local skill or project OpenCode configuration. Setup adds guidance only. Recheck current files before relying on this historical observation.

Observed on `master` at merge commit `20349c8` (2026-10-23), after Waves 1-1 to 1-3 merged:

- Firebase Auth/RTDB emulator configuration from Wave 1-1 (SEGU-207) at the repository root: `firebase.json`, `.firebaserc` (demo aliases only), `database.rules.json` (deny all), plus `firebase/README.md`, `firebase/.env.example` and `tests/firebase/bootstrap.test.ts`. The root layout comes from `firebase init database --project demo-takebase --non-interactive`; `firebase init emulators` is interactive-only.
- An untracked `functions/` Cloud Functions scaffold left by an earlier interactive `firebase init` was deleted at the human's request on 2026-10-22. Cloud Functions is not a Takebase component.
- Wave 1-2 (SEGU-208, PR #1): the root pnpm workspace (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`), `packages/core` (request store), the Worker examples `examples/workers/global` and `examples/workers/tenant` (each with its own `wrangler.jsonc`, `src/index.ts`, `src/context.ts`, `src/request-store.ts`), the SvelteKit example `examples/sveltekit`, empty `migrations/global` and `migrations/tenant`, and Gitea CI at `.gitea/workflows/ci.yml`.
- Wave 1-3 (SEGU-209, PR #4): `packages/contracts`, `packages/sdk` and `packages/cli` (with `templates/starter`), plus `tests/cli`, `tests/contracts` and `tests/architecture`.

The Takebase monorepo tree and CLI in the Multica project description are **planned product structure and capabilities**, not implemented components or verified commands. No application directories or commands are established by bootstrap. Read the complete project description when planning authorized work; do not silently discard its folder tree, CLI capabilities or examples.

For any component created with an official platform generator, preserve its established layout, entry points, configuration, scripts, tests, emulators and deployment mechanisms. Discover actual components; do not assume an `apps/` layout or pre-existing Cloudflare/Firebase setup. Do not collapse components into a single file, move entry points or invent parallel build/run/deploy tooling. Reinitialization, overwriting generated configuration or departing from established platform structure requires explicit human approval. Use official generators only for separately authorized scaffolding.

Use graph-first code discovery: CodeGraph when indexed, plus codebase-memory-mcp search/trace/snippets. A `.codegraph/` directory is present; that alone does not prove a usable index. Text search/direct reads are fallbacks for configuration, documentation or graph gaps. Do not initialize an index or repair tooling without authorization.

## Issue, handoff and test-plan requirements

The human names the wave and selects its issue. Read bounded current context rather than copying all history or creating duplicate planning documents. A compact handoff must state exact issue UUID/key, project/workspace/profile, absolute root and actual component working directory, wave label, observable acceptance, accepted decisions/current progress, focused read/change paths, verified check commands and prerequisites, preserved work, exclusions and stop point. Mark new paths and inferred commands as proposed, not verified.

Each implementation test plan distinguishes local, mocked, observed and exact-SHA remote evidence. Missing or unavailable checks are not passes. Checks must correspond to the actual candidate and run from their real component directories. Only the local Firebase emulator checks listed below are verified; there are no verified application build/deploy commands or package scripts yet, so do not invent them.

## Mandatory implementation preflight, evidence and review

Bootstrap is a setup-only exception, not an implementation wave. Do not run application tests or `wavelens begin` for bootstrap.

Before implementation edits:

1. Resolve exact issue/repository/workspace/profile/wave identity and inspect Git status plus existing edits.
2. Run `wavelens status --repo /Volumes/Workspace/dev-drakecall/node/takebase`.
3. If no active wave, run `wavelens begin <human-selected-issue-key> --repo /Volumes/Workspace/dev-drakecall/node/takebase --wave <agreed-label> --profile <resolved-profile> --workspace-id 237ef0f7-262b-4830-9d1a-c86b40b59fda`.
4. Recheck status and require matching metadata plus a recorded pre-edit baseline. Fill placeholders from the selected issue before emitting an execution prompt. Never replace another wave automatically. If issue edits already exist without a baseline, stop and agree retrospective scope.
5. Stop before edits on missing tooling, authorization, identity, data permission or baseline. Do not initialize Git, create an initial commit or install tools just to bypass preflight.

Run agreed checks through `wavelens record --repo /Volumes/Workspace/dev-drakecall/node/takebase --scope local -- <verified-command>` from the command's actual working directory. Preserve nonzero results; use mocked/remote scope only for actual corresponding evidence. Rerun after relevant source/environment changes, not merely to collect another report. Output capture must not retain secrets or sensitive payloads.

At every human-agreed wave-section checkpoint and the full wave, post a Multica follow-up with changes, passed/failed/unavailable checks and remaining work. After checking patch scope, privacy and evidence, the normal final step is `wavelens preview --no-open --publish --repo /Volumes/Workspace/dev-drakecall/node/takebase`, attaching the exact review and patch to the selected issue. If generation succeeds but publication fails, retry `wavelens publish --repo /Volumes/Workspace/dev-drakecall/node/takebase` with the existing snapshot. Regenerate only for material source/evidence changes. Do not manually recreate the review; report a persistent blocker. Skip publication only on explicit human instruction.

Publication never changes issue status; after verifying the attached review, update status separately under the lifecycle below. Stop for human review; do not select another section or wave automatically. Planning, issue status and generated prompts do not authorize implementation. Commit, push, PR, merge and deploy each require corresponding human authority.

## Selected issue status lifecycle

The human's request to plan or implement a selected issue authorizes routine status updates without a separate confirmation. Use the Multica CLI to resolve the actual available statuses and verify each saved update.

- Planning when planning starts.
- Awaiting Approval when the recorded plan awaits implementation approval.
- In Progress/Building when implementation starts.
- Done once all agreed acceptance criteria and required checks pass and the Wavelens review is attached (or explicitly waived).
- In Review when a required human acceptance or authorized delivery step is pending.
- Blocked/Error for a concrete unresolved prerequisite or failed required check.

Do not mark an unfinished issue Done at a section checkpoint, close an unfinished parent when one child completes, or start another issue automatically. Planning alone does not complete an implementation issue. A local issue can reach Done without a commit. An issue that ships code closes on merge: after its branch is pushed and CI passes on the exact commit, it is In Review while its pull request to `master` is open, and Done only after the PR is merged, recording the PR link and merge commit. Passing CI alone never makes it Done; the CI callback never changes status. If agreed completion includes Git delivery, CI, merge, or deployment, those explicitly authorized requirements must be satisfied first. Git actions and deployment still require their matching human request.

Wavelens publication itself does not change status. After verifying the review attachment, the current session updates the issue separately through Multica under this standing lifecycle rule.

Segutrends status keys observed on 2026-10-19 (`multica issue status` rejects unknown keys with the valid list): `backlog`, `todo`, `planning`, `spec_review`, `awaiting_approval`, `building`, `in_progress`, `verifying`, `in_review`, `blocked`, `done`, `cancelled`, plus autopilot keys that this workflow never uses. There is no `error` key; use `blocked`. Change status with `multica issue status <issue> <key> --no-start` so no agent run starts, then read the issue back to verify.

## Conditional Worker coding conventions

The example Workers under `examples/workers/` (Wave 1-2) follow these rules. Apply them to any Worker component that already exists or that separately authorized work adds; bootstrap does not add source or compatibility flags.

- Prefer arrow functions. Platform-required `WorkerEntrypoint`, `WorkflowEntrypoint` and `DurableObject` class methods build context and delegate to arrow functions.
- Keep one central export point per Worker at its verified Wrangler main (`src/index.ts` when appropriate); implementation lives in exported modules.
- Keep one composition root: `createContext(env, request?)` builds settings, clients and request values.
- Use a request-store module wrapping `AsyncLocalStorage`, with the Workers `nodejs_als` compatibility flag, for typed request context. Entry points install it with `runInRequest(createContext(...), fn)`; internal functions use `useContext()` and typed `requestLocals.get/set`. Access outside a scope throws. This is server request state, not browser localStorage.
- Never hold mutable production user, tenant, session or request data at module scope. Isolates persist and handle concurrent requests. Documented local/test instrumentation must not hold production request data.
- Cron, queue, Workflow-step and RPC entrypoints each open their own request scope.
- Discover actual roots/configuration and current platform documentation first; report architecture conflicts instead of silently migrating application code.

## Verified setup commands versus future commands

Verified CLI contracts/reads during bootstrap: `multica workspace get --output json`, `multica project list --output json`, `multica project resource list 6f84dfa1-a433-4994-bcc1-9a79819f297f --output json`, `multica issue list --project 6f84dfa1-a433-4994-bcc1-9a79819f297f --output json`, `multica skill list --output json`, and skill reads with `--with-content`.

Initially `git status --short` reported no Git repository. The human subsequently initialized Git; setup verified the correct root and HEAD `947297e24e4b596a7931aeb6f98a1153d67878ab`. Preserve that history. Wavelens is installed at `/Users/fernandoleal/.local/bin/wavelens`, but baseline/review functionality is not validated by setup. Wave 1-1 (SEGU-207) later exercised `begin`, `record`, and `preview --no-open --publish` successfully with the unprofiled Multica configuration (no `--profile`); `preview` also writes a local copy under `reviews/`, which is git-ignored. An implementation still requires its own matching pre-edit baseline. Jumbo is not initialized; bootstrap does not initialize it.

At bootstrap no `takebase` (formerly `edgekit`) command in the product description was installed or verified; Wave 1-3 below adds only `init` and `create`. No application tests were run during setup. Validation outcomes belong to the setup issue, not claims of feature verification.

Commands verified locally in Wave 1-1 (SEGU-207), run from the repository root with firebase-tools 15.34.0, OpenJDK 21 and Node 24.21.0:

- `firebase emulators:exec --only auth,database --project demo-takebase 'true'`
- `firebase emulators:exec --only auth,database --project demo-takebase 'node --test tests/firebase/bootstrap.test.ts'`

These are local emulator checks only, not remote Firebase evidence.

Commands verified locally in Wave 1-3 (SEGU-209), run from the repository root with Node 24.21.0 and pnpm 12.15.0: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm exec vitest run tests/cli/starter.test.ts tests/contracts/public-api.test.ts tests/architecture/boundaries.test.ts`, and the CLI itself via `node packages/cli/src/bin.ts --help` / `init` / `create`. Only `init` and `create` are implemented; every other `takebase` command group is planned and exits with "not implemented yet".

## Git branches and Gitea CI mapping

The Git default branch is `master` (not `main`). Remote `origin` is the Gitea repository `ssh://git@gitea.home.lan:2222/takebase/takebase.git`; Gitea runs CI and push-mirrors to GitHub.

Commit each issue's work on its own branch named `feature/<ISSUE-KEY>-<short-description>`, for example `feature/SEGU-208-scaffold-workspace`. Use the exact Multica issue key as shown (uppercase prefix, e.g. `SEGU-208`) followed by a short lowercase kebab-case description. Gitea Actions results for the branch are reported back to that Multica issue through the key, so never omit or alter it. Create the branch from current `master` when authorized delivery starts; do not commit issue work directly to `master`. Every commit subject starts with the issue key: `<ISSUE-KEY>: <imperative summary>` (e.g. `SEGU-208: Scaffold the pnpm workspace`). Wavelens reviews stay attached to the Multica issue only; `/reviews/` is git-ignored and never committed. Feature branches land on `master` through a Gitea pull request whose title carries the issue key, never by pushing or merging directly to `master`. Pushing, opening a pull request and merging to `master` each still require the matching human request.

## Durable instruction ownership

`PROJECT_GUIDE.md`, `CLAUDE.md`, `JUMBO.md` and local skills are durable guidance. Root `AGENTS.md` belongs to Multica as temporary runtime context: never create, edit, delete, restore, stage or commit it as durable guidance. Root ignores include `/AGENTS.md` and `/.codegraph/`. Preserve any future component `AGENTS.md` files, unrelated skills, secrets, application code/tests, dependencies, hooks, remotes, Git history and existing edits.
