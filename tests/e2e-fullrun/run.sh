#!/usr/bin/env bash
# run.sh — FULL-RUN end-to-end harness for spec 08 (step 8-C + Pass 2). The reproducible
# clean-machine proof of the spec-08 "Full run" + Definition of Done across BOTH planes:
#
#   up (all-healthy) -> seed (+ idempotency) -> browser reaches Keycloak ->
#     PUBLIC: public-edge sanity -> Chromium -> client TRANSFER-WITH-OTP e2e
#     ADMIN : admin-edge sanity -> demo-admin bearer whoami 200 -> admin login.e2e.ts
#   -> teardown.
#
# It uses an ISOLATED compose project and an --env-file temp copy of .env.example, so it
# never reads or writes your real `.env` and a teardown can only remove what it created.
# (For the human "run the demo" flow — `cp .env.example .env` then `docker compose up
# --build` — see the repo-root README.md.)
#
# Usage:
#   bash tests/e2e-fullrun/run.sh          # full run; tears the stack down at the end
#   bash tests/e2e-fullrun/run.sh keep     # full run; leaves the stack UP for inspection
#   bash tests/e2e-fullrun/run.sh down     # tear down this harness's isolated project
#
# Exit code is non-zero if any check FAILED. SKIPs (no daemon, offline, host ports in use,
# *.localtest.me DNS unavailable, no browser) never fail the run — a real serving/transfer
# failure does. Written for POSIX bash (Git Bash / MSYS on Windows), NOT PowerShell.
#
# All phases live in lib.sh — see README.md for what each proves.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() { printf 'Usage: %s [run|keep|down]\n' "$(basename "$0")" >&2; }

trap global_cleanup EXIT INT TERM

MODE="${1:-run}"
case "$MODE" in
  run)        run_all ;;
  keep)       KEEP_STACK=1; run_all ;;
  down)       down_only ;;
  -h|--help)  usage; exit 0 ;;
  *)          usage; exit 2 ;;
esac

print_summary
[ "$FAIL_COUNT" -eq 0 ]
