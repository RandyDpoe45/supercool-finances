#!/usr/bin/env bash
# run.sh — verification suite for BOTH TRANSPORT edges (Spec 06):
#   PUBLIC   : public-nginx (:8080)   -> public-kong   -> balance-service
#              vertical slice GET /balance/api/whoami (customer role)
#   INTERNAL : internal-nginx (:8081) -> internal-kong -> balance-service + analytics-server
#              vertical slice GET /balance/admin/whoami + /analytics/admin/whoami (admin role)
#
# Runs the STATIC checks (docker CLI only, no live stack) then the RUNTIME checks
# (need the FULL stack already running via `docker compose up`; each edge is probed and
# skipped independently with an explicit message when unreachable), then prints a summary.
# Exits non-zero if any check FAILED. Skips never fail the run.
#
# Usage:
#   ./run.sh            # static then runtime (default)
#   ./run.sh static     # stack-free checks only (public 1-3 + internal I1-I3)
#   ./run.sh runtime    # live-stack checks only (public 4-9 + internal I4-I9)
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
