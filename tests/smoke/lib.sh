#!/usr/bin/env bash
# Shared helpers for the manual smoke scripts in tests/smoke (bash 3.2, macOS).
# Each step prints PASS or FAIL with what it expected; nothing secret is printed.
# Source it from a script: . "$(dirname "$0")/lib.sh"

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Used by the scripts that source this file.
# shellcheck disable=SC2034
CLI="node $ROOT/packages/cli/src/bin.ts"
SMOKE_LOG_DIR="${TMPDIR:-/tmp}/takebase-smoke"
mkdir -p "$SMOKE_LOG_DIR"
PASSED=0
FAILED=0
STACK_STARTED=0
OUT=""
CODE=0

section() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
pass() { PASSED=$((PASSED + 1)); printf '\033[32mPASS\033[0m %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); printf '\033[31mFAIL\033[0m %s\n' "$*"; }

# run <command...>: runs it from the repo root, keeping its output in $OUT and exit code in $CODE.
run() {
	OUT="$(cd "$ROOT" && "$@" 2>&1)"
	CODE=$?
}

# check <label> <expected exit> <text the output must contain>... ; uses $OUT and $CODE.
check() {
	local label="$1" expected="$2" needle
	shift 2
	if [ "$CODE" != "$expected" ]; then
		fail "$label (exit $CODE, expected $expected)"
		printf '%s\n' "$OUT" | tail -15 | sed 's/^/     | /'
		return 1
	fi
	for needle in "$@"; do
		case "$OUT" in
		*"$needle"*) ;;
		*)
			fail "$label (missing: $needle)"
			printf '%s\n' "$OUT" | tail -15 | sed 's/^/     | /'
			return 1
			;;
		esac
	done
	pass "$label"
}

# refute <label> <text>...: the last output must contain none of them.
refute() {
	local label="$1" needle
	shift
	for needle in "$@"; do
		case "$OUT" in
		*"$needle"*)
			fail "$label (output contains a value it must not)"
			return 1
			;;
		esac
	done
	pass "$label"
}

# Asks the human to do something in another terminal and waits for Enter.
second_window() {
	printf '\n\033[33m>>> OPEN A SECOND TERMINAL and run:\033[0m\n    cd %s\n    %s\n' "$ROOT" "$1"
	printf '\033[33m>>> %s, then press Enter here.\033[0m ' "${2:-When it is running}"
	read -r _
}

# `localhost`, not 127.0.0.1: Vite may listen on ::1 only.
stack_up() {
	curl -s -o /dev/null --max-time 2 http://localhost:5173/ 2>/dev/null &&
		curl -s -o /dev/null --max-time 2 http://127.0.0.1:8788/health 2>/dev/null
}

# Starts `pnpm dev:stack` (or the pnpm script given, e.g. dev:stack:keep) in the
# background (log in $SMOKE_LOG_DIR) and waits for the app, unless a stack
# already answers. stop_stack runs on exit.
start_stack() {
	local script="${1:-dev:stack}"
	if stack_up; then
		pass "local stack already running (left running at the end)"
		return 0
	fi
	section "Starting pnpm $script (log: $SMOKE_LOG_DIR/dev-stack.log)"
	(cd "$ROOT" && pnpm "$script" >"$SMOKE_LOG_DIR/dev-stack.log" 2>&1 &)
	STACK_STARTED=1
	local waited=0
	until stack_up; do
		sleep 2
		waited=$((waited + 2))
		if [ "$waited" -ge 300 ]; then
			fail "the stack did not start within 300 s; see $SMOKE_LOG_DIR/dev-stack.log"
			finish
		fi
	done
	pass "local stack is up after ${waited} s"
}

stop_stack() {
	if [ "$STACK_STARTED" = 1 ]; then
		section "Stopping the stack"
		run pnpm dev:stack:stop
		check "pnpm dev:stack:stop frees every port" 0 "ports are free"
		STACK_STARTED=0
	fi
}

finish() {
	stop_stack
	printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASSED" "$FAILED"
	[ "$FAILED" = 0 ] && exit 0 || exit 1
}

trap 'stop_stack' INT TERM
