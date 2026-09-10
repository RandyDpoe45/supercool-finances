#!/usr/bin/env bash
# run.sh — verification suite for the PUBLIC EDGE of TRANSPORT (Spec 06, Step 1):
# public-nginx (:8080) -> public-kong -> balance-service, plus the vertical-slice
# checkpoint (GET /api/whoami echoes the Kong-injected identity).
#
# Runs the STATIC checks (docker CLI only, no live stack) then the RUNTIME checks
# (need the FULL stack already running via `docker compose up`; skipped with an
# explicit message when the edge is not reachable), then prints a summary. Exits
# non-zero if any check FAILED. Skips never fail the run.
#
# Usage:
#   ./run.sh            # static then runtime (default)
#   ./run.sh static     # daemon/stack-free checks only (checks 1-3)
#   ./run.sh runtime    # live-stack checks only (checks 4-9)
#
# SCOPE: the PUBLIC plane only (spec 06 DoD lines for /api + the vertical slice).
# The /admin surface, the internal edge, and analytics are Step 2 — NOT tested here.
#
# All checks are defined in lib.sh. Each maps to a Definition-of-Done line in
# specs/06-transport.md — see README.md.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  printf 'Usage: %s [all|static|runtime]\n' "$(basename "$0")" >&2
}

trap global_cleanup EXIT INT TERM

MODE="${1:-all}"
case "$MODE" in
  static)  run_static ;;
  runtime) run_runtime ;;
  all)     run_static; run_runtime ;;
  -h|--help) usage; exit 0 ;;
  *)       usage; exit 2 ;;
esac

print_summary
[ "$FAIL_COUNT" -eq 0 ]
