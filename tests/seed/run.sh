#!/usr/bin/env bash
# run.sh — verification suite for the SEED DATA step of spec 08 (step 8-B):
# the idempotent `seed`-profile tool that loads the demo customers + accounts into the
# `balance` DB, aligned to the pinned Keycloak subs in tools/keycloak/realm-export.json.
#
# Runs the STATIC checks (docker CLI `compose config` + python + file reads; no live
# stack) then the RUNTIME checks (need the Docker daemon: brings up postgres + redis,
# BUILDS + boots balance-service so migrations apply, runs the seed TWICE, queries the
# DB, then tears down), then a summary. Exits non-zero if any check FAILED; skips never
# fail the run.
#
# Usage:
#   ./run.sh            # static then runtime (default)
#   ./run.sh static     # stack-free checks only (Checks 1-3)
#   ./run.sh runtime    # daemon checks only (baseline + R1-R5)
#
# Each check maps to a behavior in the "Seed data" section + Definition of Done of
# specs/08-build-and-serve.md — see README.md. Checks are written FROM the spec, not
# from the implementor's seed code.
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
