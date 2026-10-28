#!/usr/bin/env bash
# Local acceptance smoke of the SEGU-222 admin (Wave 5-4): static checks
# (including the admin's svelte-check and its static build to public/), the
# S-5-4-01 journey in a browser (pnpm e2e:admin), and the stack's health with
# the admin served on :5174. The security details live in the automated tests.
#
#   pnpm smoke:admin            static checks, the journey, then the local stack
#   pnpm smoke:admin --quick    skip lint, typecheck and pnpm test
#
# One terminal is enough: Playwright starts and stops its own fresh stack for
# the journey, then this script starts `pnpm dev:stack` and stops it with
# `pnpm dev:stack:stop` at the end. Emulators and local D1 only.

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

# Never while a stack runs: pnpm test, the journey and dev:stack share local D1
# and ports.
if stack_up; then
	fail "a local stack is running; stop it with pnpm dev:stack:stop"
	finish
fi

if [ "${1:-}" != "--quick" ]; then
	section "Static checks"
	run pnpm lint
	check "pnpm lint" 0
	run pnpm typecheck
	check "pnpm typecheck" 0
	run pnpm test
	check "pnpm test" 0
	run pnpm --filter @takebase/adminui build
	check "admin static build" 0 'Wrote site to "../../public"'
fi

section "S-5-4-01 journey (Playwright starts its own stack)"
run pnpm e2e:admin
check "pnpm e2e:admin" 0 "2 passed"
# Frees anything Playwright's stack left on the ports before the next start.
(cd "$ROOT" && pnpm dev:stack:stop >/dev/null 2>&1)

start_stack

section "Health"
run $CLI health
check "takebase health" 0 "All Workers are live and ready." "admin: HTTP 200"

finish
