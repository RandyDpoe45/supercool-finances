#!/usr/bin/env bash
# run.sh — verification suite for the IDENTITY PROVIDER (Spec 02 — Keycloak).
#
# Runs the STATIC checks (docker CLI only, no daemon) then the RUNTIME checks (need the
# daemon; skipped with an explicit message if it is down / if keycloak is not wired yet),
# then prints a summary. Exits non-zero if any check FAILED. Skips never fail the run.
#
# Usage:
#   ./run.sh            # static then runtime (default)
#   ./run.sh static     # daemon-free checks only (checks 1-5)
#   ./run.sh runtime    # daemon checks only (checks 6-9)
#
# All checks are defined in lib.sh. Each maps to a Definition-of-Done line in
# specs/02-keycloak.md — see README.md.
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
