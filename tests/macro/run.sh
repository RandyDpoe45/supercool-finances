#!/usr/bin/env bash
# run.sh — verification suite for the Docker Compose spine (Spec 00 — Macro Architecture).
#
# Runs the STATIC checks (no Docker daemon needed) then the RUNTIME checks (need the
# daemon; skipped with an explicit message if it is down/absent), then prints a summary.
# Exits non-zero if any check FAILED. Skips never fail the run.
#
# Usage:
#   ./run.sh            # static then runtime (default)
#   ./run.sh static     # daemon-free checks only (checks 1-7)
#   ./run.sh runtime    # daemon checks only (checks 8-9)
#
# All checks are defined in lib.sh. Each check maps to a Definition of Done line in
# specs/00-architecture.md §8 — see README.md.
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
