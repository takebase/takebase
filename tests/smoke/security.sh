#!/usr/bin/env bash
# Local acceptance smoke of the SEGU-228 hardening (Wave 7-1): static checks, the
# stack's health, and the S-7-1-01 boundary journey. The security details live
# in the automated tests.
#
#   pnpm smoke:security            static checks, then the local stack
#   pnpm smoke:security --quick    skip lint, typecheck and pnpm test
#
# Starts `pnpm dev:stack` itself (one terminal is enough) and stops it with
# `pnpm dev:stack:stop` at the end. Emulators and local D1 only.

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

if [ "${1:-}" != "--quick" ]; then
	# Never while a stack runs: pnpm test and dev:stack share local D1 and ports.
	if stack_up; then
		fail "a local stack is running; stop it with pnpm dev:stack:stop or use --quick"
		finish
	fi
	section "Static checks"
	run pnpm lint
	check "pnpm lint" 0
	run pnpm typecheck
	check "pnpm typecheck" 0
	run pnpm test
	check "pnpm test" 0
fi

start_stack

section "Health"
run $CLI health
check "takebase health" 0 "All Workers are live and ready."

section "S-7-1-01 boundary journey"
run node tests/fixtures/security-journey.ts
check "pnpm journey:security" 0 "All S-7-1-01 boundary checks passed."

finish
