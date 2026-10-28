#!/usr/bin/env bash
# Local acceptance smoke of the encrypted tenant secrets (SEGU-223, Wave 6-1)
# and their key rotation (SEGU-224, Wave 6-2):
# static checks, the encryption tests (tampering, wrong tenant, environment
# or key version, missing key, nothing secret in KV), the rotation tests
# (mixed versions, resume, no leak), fresh local data keys
# for tenant-a and tenant-b, the stack's health and the S-6-1-01 journey. The
# security details live in the automated tests.
#
# The local keys file (ops/.local.env) holds disposable demo keys only; this
# script replaces it, and `pnpm dev:stack` (--fresh) starts each tenant's KV
# empty, so nothing encrypted under an old key survives.
#
#   pnpm smoke:secrets            static checks, then the stack
#   pnpm smoke:secrets --quick    skip lint, typecheck and pnpm test
#
# Starts `pnpm dev:stack` itself (one terminal is enough) and stops it with
# `pnpm dev:stack:stop` at the end. Emulators and local state only; no key or
# secret value is printed.

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

section "Encryption"
run pnpm --filter @takebase/core exec vitest run test/secrets.test.ts
check "AES-256-GCM envelopes refuse tampering, substitution and missing keys" 0 "5 passed"
run pnpm exec vitest run tests/security/secret-rotation.test.ts
check "key rotation re-encrypts mixed versions, resumes, and leaks no key or value" 0 "4 passed"

section "Local data keys"
# Each tenant Worker loads its key when it starts, so the stack must be down.
if stack_up; then
	fail "a local stack is running; stop it with pnpm dev:stack:stop first"
	finish
fi
/bin/rm -f "$ROOT/ops/.local.env"
run $CLI secrets init tenant-a
check "takebase secrets init tenant-a generates and stores a key" 0 "Generated a new data key DATA_KEY_V1" "mode 600"
run $CLI secrets init tenant-b
check "takebase secrets init tenant-b generates and stores a key" 0 "Generated a new data key DATA_KEY_V1"
run $CLI secrets init tenant-a
check "a second init is refused" 1 "never replaces a key"

start_stack

section "Health"
run $CLI health
check "takebase health: every tenant's secrets are ok" 0 "All Workers are live and ready." "realtime ok, secrets ok"

section "S-6-1-01 journey"
run node tests/fixtures/secrets-journey.ts
check "pnpm journey:secrets" 0 "All S-6-1-01 checks passed."

finish
