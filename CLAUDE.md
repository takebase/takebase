# Claude Code Instructions

@PROJECT_GUIDE.md
@JUMBO.md

OpenCode plans interactively. Claude Code implements the human-selected issue. Multica holds accepted plans, decisions, progress, and verification evidence.

## Resolve the current project

If the human has not explicitly named the current Multica project, ask: "Which Multica project should I use for this folder?" Wait for the answer. Use the Multica CLI to resolve its project and workspace IDs and verify that its attached local directory matches the current repository root. Never assume a project name, ID, workspace, issue key, or machine path from a different project. Stop on a missing or mismatched attachment.

The bootstrap-verified identity is Takebase (`6f84dfa1-a433-4994-bcc1-9a79819f297f`), workspace Segutrends (`237ef0f7-262b-4830-9d1a-c86b40b59fda`), root `/Volumes/Workspace/dev-drakecall/node/takebase`. Reverify it; stored identity is not permission to skip the CLI or human selection. Current components and verified commands are listed in PROJECT_GUIDE.md. The human initialized Git during setup and HEAD was verified; preserve that history. Do not bypass a missing Wavelens implementation baseline.

Read PROJECT_GUIDE.md, JUMBO.md, applicable component instructions, and the local skill for the requested work. Before source edits read `.agents/skills/execute-approved-plan/SKILL.md`. For separately authorized Git delivery read `.agents/skills/commit-and-close-issue/SKILL.md` in the same implementing session.

## Multica CLI access

Use direct `multica` commands for the human's requested project and issue operations, including project descriptions, issue plans, and progress comments. The prohibition on dispatching agents does not prohibit these CLI operations. Read existing content, preserve unrelated content, and verify the saved result. Never save placeholder examples as real descriptions.

Use the installed CLI's supported flags. Prefer direct commands over interpreter wrappers; use file/stdin flags for long content where supported. Project update currently uses `--description`. Inspect safety-tool rejections and test a clearer direct command with its diagnostic mode; do not disable secret protections.

## One wave at a time

Use CodeGraph (`codegraph_explore` or `codegraph explore`) when the repository is indexed, plus codebase-memory-mcp (`search_graph`, `trace_path`, `get_code_snippet`) for code discovery. Use text search or direct reads for configuration, documentation, or details the graphs do not cover. Use the Multica CLI for issue context and progress, and Wavelens for baselines, recorded checks, and visual reviews.

1. The human names the wave and selects the issue. Do not choose or start work independently.
2. Read the selected wave's issues, sub-issues, latest comments and handoff, accepted plan, and decisions using the Multica CLI. Then map the relevant code through the graphs.
3. Before implementation edits, resolve the exact issue UUID/key, workspace/profile, root, and wave label. Run `wavelens status --repo <resolved-root>`, conditionally `wavelens begin <issue-key> --repo <resolved-root> --wave <wave-label> --profile <profile> --workspace-id <workspace-id>`, then recheck status. Require the matching pre-edit baseline. Stop on missing/mismatched tooling, identity, authorization, or baseline. Never replace another wave automatically; agree retrospective scope for existing issue edits without a baseline.
4. Implement the approved scope. Run checks through `wavelens record --repo <resolved-root> --scope local -- <command>` from their actual working directories. Preserve failures and distinguish unavailable checks from passed checks.
5. At the end of each human-agreed wave section and the full wave, use `multica issue comment` to record what changed, checks passed or failed, unavailable checks, and remaining work. Maintain status according to the selected-issue lifecycle below.
6. At those same checkpoints, check patch scope and privacy, then run `wavelens preview --no-open --publish --repo <resolved-root>` to attach the visual review and patch to the selected issue. If generation succeeded but publication failed, retry `wavelens publish --repo <resolved-root>` with the existing snapshot. Skip publication only on explicit human instruction.
7. Stop for human review at the agreed checkpoint. Wait for the human's next step or wave.

## Selected issue status lifecycle

The human's request to plan or implement a selected issue authorizes routine status updates without a separate confirmation. Use the Multica CLI to resolve the actual available statuses and verify each saved update.

- Planning when planning starts.
- Awaiting Approval when the recorded plan awaits implementation approval.
- In Progress/Building when implementation starts.
- Done once all agreed acceptance criteria and required checks pass and the Wavelens review is attached (or explicitly waived).
- In Review when a required human acceptance or authorized delivery step is pending.
- Blocked/Error for a concrete unresolved prerequisite or failed required check.

Do not mark an unfinished issue Done at a section checkpoint, close an unfinished parent when one child completes, or start another issue automatically. Planning alone does not complete an implementation issue. A local issue can reach Done without a commit. If agreed completion includes Git delivery, CI, merge, or deployment, those explicitly authorized requirements must be satisfied first. Git actions and deployment still require their matching human request.

Wavelens publication itself does not change status. After verifying the review attachment, the current session updates the issue separately through Multica under this standing lifecycle rule.

## Respect each platform's default project structure

For each component created with a platform's official init tool, preserve that tool's layout and conventions so its CLI, emulators, tests, and deploy commands continue to work. Discover the components actually present; do not assume this project uses any fixed component folder. EdgeKit's planned stack does not establish an existing implementation.

- Before adding code, inspect the component's existing layout, configuration, package scripts, entry points, and applicable instructions. Put new code where the established structure expects it.
- Use the platform's own configuration, generation, run, test, and deploy mechanisms. For a Cloudflare component, this may include Wrangler bindings/environments and the existing type-generation script. For a Firebase component, this may include configured targets, the functions package, and rules/index files. Use only paths and commands verified in the current project.
- Do not collapse a component into a single file, scatter it into an ad-hoc layout, move entry points, or invent parallel build, run, or deploy paths.
- Do not re-run init tools or overwrite generated configuration without explicit human approval. When authorized work needs scaffolding, use the platform's official generator or command. If work requires departing from the established platform structure, stop and ask the human first.

## Worker coding conventions

Apply these conventions to source and tests in Cloudflare Worker components when the project uses them. Discover each Worker's actual root and applicable component instructions; do not assume an `apps/` layout or a reference implementation from another repository. These are implementation conventions, not permission to refactor or scaffold application code during bootstrap.

- Use arrow functions (`const name = (...) => { ... }`) rather than function declarations. Classes required by Cloudflare, such as `WorkerEntrypoint`, `WorkflowEntrypoint`, and `DurableObject`, retain class methods; those methods build context and delegate to arrow functions.
- Keep one central export point per Worker. Its `src/index.ts` (or the project's verified Wrangler main) re-exports the default fetch handler, named entrypoint classes, and public symbols; implementation logic lives in the modules it exports.
- Keep one composition root per Worker: `createContext(env, request?)` in its context module builds settings, service clients, and per-request values such as client IP and time in one place.
- Use a request-store module wrapping `AsyncLocalStorage`, with the Workers `nodejs_als` compatibility flag, for server-side request context. Entry points install context once through `runInRequest(createContext(...), fn)`. Internal functions use `useContext()` and `requestLocals.get/set` rather than passing context through every call. `RequestLocals` keys are typed fields, never free-form. Access outside `runInRequest` throws. This state exists only for the scope of one Worker request; it is unrelated to browser localStorage.
- Never keep mutable user, tenant, session, or request data at module scope: isolates handle concurrent requests and module variables persist. Documented local/test instrumentation may use module-level mutable state, but it must not hold production request data.
- Every execution outside a fetch request, including cron handlers, queue consumers, and Workflow steps, opens its own `runInRequest` scope. Each RPC entrypoint method also opens its own scope.
- Preserve established platform structure and read current platform documentation and configuration before implementing compatibility changes. Apply these rules within the human-approved work; report conflicts with the current architecture instead of silently performing a broad migration.

Planning, issue status, and generated prompts do not authorize implementation. Preserve unrelated work and component instructions. Root AGENTS.md is temporary Multica context; never create, edit, delete, restore, stage, or commit it as durable guidance. Do not invoke Jumbo lifecycle/delegation commands or dispatch agents, wakeups, schedules, or automatic follow-up. Commit, push, pull request, merge, and deploy require the corresponding human request. Routine issue statuses and Done follow the selected-issue lifecycle.
