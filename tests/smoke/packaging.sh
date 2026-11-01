#!/usr/bin/env bash
# Local acceptance smoke of the distributable packages (SEGU-230, Wave 7-3):
# static checks, the packages packed and installed into a disposable directory
# outside the workspace, the CLI commands no other journey drives, and a browser
# journey in a project generated from the tarballs. Nothing is published. Starts and
# stops each local stack itself; emulators and local D1 only.
#
#   pnpm smoke:packaging
#
# Needs the npm registry for the consumer's dependencies. Run it with no stack up.

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

# Never while a stack runs: pnpm test and dev:stack share local D1 and ports.
if stack_up; then
	fail "a local stack is running; stop it with pnpm dev:stack:stop"
	finish
fi
section "Static checks"
run pnpm lint
check "pnpm lint" 0
run pnpm typecheck
check "pnpm typecheck" 0
run pnpm test
check "pnpm test" 0
run pnpm build
check "pnpm build" 0

section "S-7-3-01 packed and installed"
run pnpm test:packaging
check "pnpm test:packaging" 0 "passed"

section "R-7-3-01 CLI coverage"
run $CLI build
check "takebase build" 0 "Built."
start_stack
run pnpm journey:cli
check "pnpm journey:cli" 0 "All R-7-3-01 CLI journey checks passed."
stop_stack

# Its own stack on the same ports, so the one above must be stopped first.
section "S-7-3-01 generated starter"
run pnpm e2e:starter
check "pnpm e2e:starter" 0 "1 passed"

finish
