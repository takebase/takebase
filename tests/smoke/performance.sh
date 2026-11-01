#!/usr/bin/env bash
# Local acceptance smoke of the SEGU-229 measurements (Wave 7-2): static checks,
# the S-7-2-01 contract on native SQLite (its D1 side is in pnpm test), and the
# benchmarks at a small size. It writes no results.
#
#   pnpm smoke:performance
#
# Needs Bun. Starts `pnpm dev:stack` itself (one terminal is enough) and stops it
# with `pnpm dev:stack:stop` at the end. Emulators and local D1 only.

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

section "S-7-2-01 native contract"
run pnpm spike:native
check "pnpm spike:native" 0 "native contract checks passed."

start_stack

section "Benchmarks"
run pnpm benchmark:quick
check "pnpm benchmark:quick" 0 "Benchmarks finished without errors."

finish
