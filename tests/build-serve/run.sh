#!/usr/bin/env bash
# run.sh — verification suite for the PUBLIC-PLANE BUILD-AND-SERVE step of spec 08
# (step 8-A): the client + otp SPAs built as per-SPA atomic images and served behind
# public-nginx as the path-based router, with the spec-08 port contract.
#
# Runs the STATIC checks (docker CLI + python + file reads; no live stack) then the
# RUNTIME checks (need the public edge reachable at :PUBLIC_HTTP_PORT — either an
# already-running stack, or a LIGHT self-up this suite performs), then a summary.
# Exits non-zero if any check FAILED. Skips never fail the run.
#
# Usage:
#   ./run.sh            # static then runtime (default)
#   ./run.sh static     # stack-free checks only (Checks 1-5)
#   ./run.sh runtime    # live-edge checks only (R1-R9)
#
# Runtime bring-up:
#   - If the edge is ALREADY reachable at http://localhost:${PUBLIC_HTTP_PORT}
#     (you ran `docker compose up -d --build` first), the checks run against it.
#   - Otherwise, unless BUILD_SERVE_NO_SELFUP=1, the suite performs a LIGHT self-up
#     (`docker compose up -d --build --no-deps public-nginx client-app otp-app`) in an
#     isolated project and tears it down afterward. A real build/serve failure FAILs;
#     an offline/registry failure SKIPs (never a false pass).
#
# SCOPE: PUBLIC plane only (spec 08 scope note). The admin SPA, :8081, and the
# transfer-with-OTP / maker-checker e2e flows (steps 8-B/8-C) are NOT tested here.
#
# All checks are defined in lib.sh; each maps to a spec-08 behavior — see README.md.
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
