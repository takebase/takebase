#!/usr/bin/env bash
# Local acceptance smoke of the encrypted tenant secrets (SEGU-223, Wave 6-1)
# and their key rotation (SEGU-224, Wave 6-2):
# static checks, the encryption tests (tampering, wrong tenant, environment
# or key version, missing key, nothing secret in KV), the rotation tests
# (mixed versions, resume, no leak), lost-key recovery from a simulated
# escrow, fresh local data keys
# for tenant-a and tenant-b, the stack's health, the S-6-1-01 journey and the
# S-6-2-01 rotation journey (tenant-a: an interrupted rotation, resumed,
# verified and retired; then a lost key recovered from the escrow). The
# security details live in the automated tests.
#
# The local keys file (ops/.local.env), escrow (ops/.escrow/local) and rotation
# records (ops/.rotation/local-*) hold disposable demo keys and counts only;
# this script replaces them, and `pnpm dev:stack` (--fresh) starts each
# tenant's KV empty, so nothing encrypted under an old key survives.
#
#   pnpm smoke:secrets            static checks, then the stack
#   pnpm smoke:secrets --quick    skip lint, typecheck and pnpm test
#
# Starts `pnpm dev:stack` itself (one terminal is enough), restarts it with
# `pnpm dev:stack:keep` (KV kept) around the rotation, and stops it with
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
run pnpm exec vitest run tests/security/key-recovery.test.ts
check "a lost key is restored from the simulated escrow only if it opens the secrets" 0 "3 passed"
run pnpm exec vitest run tests/cli/secrets-rotate.test.ts
check "secrets rotate retires the old key only when nothing needs it; recover reinstalls" 0 "3 passed"

section "Local data keys"
# Each tenant Worker loads its key when it starts, so the stack must be down.
if stack_up; then
	fail "a local stack is running; stop it with pnpm dev:stack:stop first"
	finish
fi
/bin/rm -f "$ROOT/ops/.local.env" "$ROOT"/ops/.rotation/local-*.json
/bin/rm -rf "$ROOT/ops/.escrow/local"
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
stop_stack

section "S-6-2-01 rotation journey (tenant-a)"
JOURNEY="node tests/fixtures/rotation-journey.ts"
run $JOURNEY seed
check "fixture secrets stored under DATA_KEY_V1" 0 "S-6-2-01 seed: passed."
run $CLI secrets rotate tenant-a --limit 3
check "an interrupted rotation (--limit 3) creates, escrows and activates DATA_KEY_V2" 0 "Created DATA_KEY_V2" "is at \"activated\""
run $JOURNEY mixed
check "the tenant's secrets are now on both keys" 0 "S-6-2-01 mixed: passed."
start_stack dev:stack:keep
run $CLI secrets check tenant-a
check "mid-rotation the Worker (V1 and V2) opens its secrets" 0 "tenant tenant-a secrets: ok"
refute "mid-rotation check reports no failure" "FAIL" "secrets: error"
stop_stack
run $CLI secrets rotate tenant-a
check "the resumed rotation verifies every secret and retires DATA_KEY_V1" 0 "open with DATA_KEY_V2" "now has one key, DATA_KEY_V2"
run $JOURNEY verify
check "every secret reads back under DATA_KEY_V2 alone" 0 "S-6-2-01 verify: passed."
start_stack dev:stack:keep
run $CLI secrets check tenant-a
check "after the restart the Worker opens its secrets with DATA_KEY_V2 alone" 0 "tenant tenant-a secrets: ok"
refute "post-rotation check reports no failure" "FAIL" "secrets: error"
stop_stack
run $JOURNEY lose
check "DATA_KEY_V2 is lost from the keys file" 0 "S-6-2-01 lose: passed."
run $CLI secrets rotate tenant-a
check "a rotation without the active key is refused" 1 "is not in" "secrets recover"
run $CLI secrets recover tenant-a
check "secrets recover restores DATA_KEY_V2 from the escrow after proving it" 0 "Restored DATA_KEY_V2 for tenant tenant-a from the escrow"
run $JOURNEY verify
check "every secret reads back again with the recovered key" 0 "S-6-2-01 verify: passed."

finish
