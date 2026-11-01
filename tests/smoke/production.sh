#!/usr/bin/env bash
# Acceptance smoke of the deployed production environment (SEGU-231): health,
# the fixture users, the API journey, the browser journey and the removal of
# the smoke records. It touches only the synthetic tenant. Run it from a normal
# terminal, because a sandbox may block the browser's network. No secret is printed.
#
#   pnpm smoke:production

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

section "Production"
run pnpm production:health
check "every Worker is live and ready" 0 "All Workers are live and ready"
run pnpm production:fixtures
check "fixture users and roles are ready" 0 "ready   outsider"
run pnpm production:journey
check "protected CRUD, realtime and refusals" 0 "All production journey checks passed"
run pnpm production:e2e
check "browser journey in the app and the admin" 0 "3 passed"
# Always last, so a failed step above still leaves no smoke records.
run pnpm production:cleanup
check "smoke records removed" 0 "smoke records left on prod-smoke: 0"

finish
