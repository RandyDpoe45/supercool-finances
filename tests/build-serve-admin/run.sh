#!/usr/bin/env bash
# run.sh — verification suite for the ADMIN-PLANE BUILD-AND-SERVE step of spec 08
# (Pass 2): the `admin-app` SPA built as a per-SPA atomic image and served by
# `internal-nginx` at `/` (:8081), while internal-nginx still routes
# /balance/admin/ + /analytics/admin/ -> internal-kong.
#
# Runs the STATIC checks (docker CLI + python + file reads; no live stack) then the
# RUNTIME checks (need the internal edge reachable at :INTERNAL_HTTP_PORT — either an
# already-running stack, or a LIGHT self-up this suite performs), then a summary.
# Exits non-zero if any check FAILED. Skips never fail the run.
#
# Usage:
#   ./run.sh            # static then runtime (default)
#   ./run.sh static     # stack-free checks only (Checks 1-4)
#   ./run.sh runtime    # live-edge checks only (R1-R6)
#
# Runtime bring-up:
#   - If the internal edge is ALREADY reachable at http://localhost:${INTERNAL_HTTP_PORT}
#     (you ran `docker compose up -d --build` first), the checks run against it — and the
#     admin-whoami VERTICAL SLICE (R4) runs for real (it needs internal-kong + balance-service
#     + keycloak all up).
#   - Otherwise, unless BUILD_SERVE_NO_SELFUP=1, the suite performs a LIGHT self-up
#     (`docker compose up -d --build --no-deps internal-nginx admin-app`) in an isolated
#     project and tears it down afterward. That proves SPA serving + that the `/` catch-all
#     does NOT shadow the admin API (kong absent -> 502, still not a SPA page); the whoami
#     vertical slice R4 SKIPs (the full internal chain is not up in a light bring-up).
#
# SCOPE: the ADMIN plane's build & serve (spec 08 Pass 2). The Kong auth SEMANTICS
# (403 role gate, anti-spoof, rate-limit) are owned by tests/transport; the admin
# maker-checker reversal e2e is NOT in this step (the reversal UI is not built).
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
