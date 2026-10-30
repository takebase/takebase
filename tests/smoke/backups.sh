#!/usr/bin/env bash
# Local acceptance smoke of the versioned backups (SEGU-225, Wave 6-3) and
# their restore (SEGU-226, Wave 6-4):
# static checks, the backup tests (integrity: a corrupted, truncated or missing
# object and a tampered manifest each fail verification and are never listed
# as verified; coverage and no secret in any object or output), then the
# S-6-3-01 journey on local data: a seeded stack, fixture secrets, a tenant, a
# global and an all backup in local R2, list, and the damage journey on the
# newest backup; then the restore of the newest backup (R-6-4-01, S-6-4-01):
# the dry-run for tenant-a and the global database, isolated restores of both,
# proved; the source fingerprint unchanged; tenant-a served from the restored
# copy (sign-in, refetch, a write that lands in the copy); then the restore
# targets are discarded; finally a protected prune. The security details live
# in the automated tests.
#
#   pnpm smoke:backups            static checks, then the journey
#   pnpm smoke:backups --quick    skip lint, typecheck and pnpm test
#
# Starts `pnpm dev:stack` itself (one terminal is enough) to seed the local
# databases, and stops it before backing up: local backups refuse a running
# stack. Creates the local data keys only when the keys file has none.
# Backups live in examples/workers/global/.wrangler/state-backups (local R2,
# git-ignored); the run ends by pruning them to the newest verified one per
# subject. No key or secret value is printed.

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
run pnpm exec vitest run tests/cli/backup-restore.test.ts
check "restore: dry-run writes nothing; bad state blocks it; isolated, resumable, proved by content; FK-safe import" 0 "15 passed"
run pnpm exec vitest run tests/cli/backup-prune.test.ts
check "prune keeps protected backups; deletes only with --confirm; an interrupted prune never lists a backup without objects" 0 "4 passed"

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
run pnpm journey:restore records
check "journey policies created in tenant-a" 0 "S-6-4-01 records: passed."
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

section "Restore dry-run (R-6-4-01)"
run $CLI backup restore --latest --tenant tenant-a --dry-run
check "restore --dry-run --tenant tenant-a: every check passes" 0 "nothing was created or changed" "ciphertext secrets, key versions v"
run $CLI backup restore --latest --global --dry-run
check "restore --dry-run --global: every check passes" 0 "nothing was created or changed" "table  tenants"

section "Isolated restore (S-6-4-01)"
run pnpm journey:restore before
check "source databases, secrets and backup fingerprinted" 0 "S-6-4-01 before: passed."
run $CLI backup restore --latest --tenant tenant-a --confirm local
check "restore --tenant tenant-a into .wrangler/restore-*: proved" 0 "proved in examples/workers/tenant/.wrangler/restore-" "rows equal the backup's" "secrets opened"
run $CLI backup restore --latest --global --confirm local
check "restore --global into .wrangler/restore-*: proved" 0 "proved in examples/workers/global/.wrangler/restore-" "rows equal the backup's"
run pnpm journey:restore verify
check "source unchanged; restored records present; restored secrets decrypt to the fixture values" 0 "S-6-4-01 verify: passed."
start_stack dev:stack:restored
run pnpm journey:restore app
check "the restored tenant serves sign-in and refetch; writes land in the copy, never the source" 0 "S-6-4-01 app: passed."
stop_stack
run pnpm journey:restore cleanup
check "restore targets discarded" 0 "S-6-4-01 cleanup: passed."

section "Protected prune (R-6-4-01)"
run $CLI backup prune --keep 1 --plan
check "prune --plan: lists decisions, deletes nothing" 0 "keep   " "newest verified all backup" "nothing was changed"
run $CLI backup prune --keep 1 --confirm local
check "prune --confirm local: keeps the newest verified per subject" 0 "Pruned"
run $CLI backup list
check "backup list after prune: every listed backup still verifies" 0 "verified"
refute "no listed backup lost its objects" "FAILED"

finish
