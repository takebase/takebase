#!/usr/bin/env bash
# Local acceptance smoke of the versioned backups (SEGU-225, Wave 6-3):
# static checks, the backup tests (integrity: a corrupted, truncated or missing
# object and a tampered manifest each fail verification and are never listed
# as verified; coverage and no secret in any object or output), then the
# S-6-3-01 journey on local data: a seeded stack, fixture secrets, a tenant, a
# global and an all backup in local R2, list, and the damage journey on the
# newest backup. The security details live in the automated tests.
#
#   pnpm smoke:backups            static checks, then the journey
#   pnpm smoke:backups --quick    skip lint, typecheck and pnpm test
#
# Starts `pnpm dev:stack` itself (one terminal is enough) to seed the local
# databases, and stops it before backing up: local backups refuse a running
# stack. Creates the local data keys only when the keys file has none.
# Backups accumulate in examples/workers/global/.wrangler/state-backups (local
# R2, git-ignored; prune is planned). No key or secret value is printed.

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

section "Backup tests"
run pnpm exec vitest run tests/cli/backup-verify.test.ts
check "damaged objects and tampered manifests fail verify and are never listed as verified; exports cannot attach files" 0 "12 passed"
run pnpm exec vitest run tests/cli/backup-create.test.ts
check "tenant, global and all backups cover their parts; no secret is written; names stay owned" 0 "4 passed"

section "Local data"
for tenant in tenant-a tenant-b; do
	upper="$(printf '%s' "$tenant" | tr 'a-z-' 'A-Z_')"
	if grep -q "^DATA_KEY_V[0-9]*_${upper}=" "$ROOT/ops/.local.env" 2>/dev/null; then
		pass "$tenant already has a local data key"
	else
		run $CLI secrets init "$tenant"
		check "takebase secrets init $tenant" 0 "the key is never printed"
	fi
done
start_stack
run $CLI health
check "takebase health: the seeded stack is healthy" 0
stop_stack
run node tests/fixtures/rotation-journey.ts seed
check "fixture secrets stored as ciphertext in tenant-a's KV" 0 "seed: passed."

section "Backups (S-6-3-01)"
run $CLI backup create --tenant tenant-a
check "backup create --tenant tenant-a" 0 "verified" "schema 0001_outbox.sql" "ciphertext secrets, key versions v"
run $CLI backup create --global
check "backup create --global" 0 "verified" "schema 0006_admin_triggers.sql"
sleep 1
run $CLI backup create --all
check "backup create --all" 0 "verified" "global" "tenant:tenant-a" "tenant:tenant-b" "config"
run $CLI backup list
check "backup list: every backup verified again" 0 "verified"
refute "backup list shows no failed backup" "FAILED"
run $CLI backup verify --latest
check "backup verify --latest" 0 ": verified"
run pnpm journey:backups
check "S-6-3-01: no key or password in the backup; each damage fails verify and list" 0 "S-6-3-01 integrity: passed."

finish
