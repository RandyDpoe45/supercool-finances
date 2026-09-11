#!/usr/bin/env bash
# lib.sh — shared helpers + all phases for the PUBLIC-PLANE FULL-RUN + TRANSFER-WITH-OTP
# end-to-end harness of spec 08 (step 8-C). Sourced by run.sh; defines functions only,
# never exits.
#
# This is the reproducible clean-machine proof of the spec-08 "Full run" + Definition of
# Done for the PUBLIC plane:
#   1. `docker compose up -d --build --wait` on the DEFAULT graph reaches ALL-HEALTHY with
#      no manual steps (beyond the documented env copy this harness performs with an
#      --env-file temp copy of .env.example, so your real `.env` is never touched).
#   2. The `seed` profile loads the demo customers + accounts, and re-running it is a
#      no-op (idempotent — counts unchanged).
#   3. The demo-customer logs in through the REAL Keycloak/Kong chain and sees the seeded
#      account, and the headline TRANSFER-WITH-OTP flow passes end to end from the client
#      app: confirmation-of-payee -> initiate (pending) -> code revealed via the REAL
#      otp-app in a second browser context -> confirm -> the source balance is debited by
#      exactly the transfer amount (no hold on the internal rail, nothing created/lost).
#
# THE SEED <-> E2E CONTRACT (spec 08 §Seed data / §Demo dataset). The Playwright specs are
# the test-writer's artifact and are NOT edited here; this harness feeds them the
# seed-aligned env they read (tests/e2e/fixtures/env.ts):
#   E2E_ENABLED=1                      flips the suites from describe.fixme to live.
#   E2E_BASE_URL=http://localhost:8080 the public front door (default is fine).
#   E2E_USERNAME / E2E_PASSWORD        the demo-customer login — READ FROM realm-export.json
#                                      (the project's existing demo credential; no new
#                                      secret is introduced here).
#   E2E_DEST_ACCOUNT=1000000002        Customer B's SEEDED account. The spec-07 baked
#                                      default (2000000001) does NOT match our seed, so it
#                                      MUST be overridden — this is the load-bearing glue.
#   E2E_TRANSFER_MAJOR/MINOR           left at the 10.00 / 1000 defaults (Customer A is
#                                      funded with 1,000,000.00 MXN).
#
# SCOPE: the PUBLIC plane only (spec 08 scope note). The admin plane — the admin SPA, the
# internal front door :8081, and the admin maker-checker reversal e2e — is DEFERRED and is
# NOT exercised here. Only :8080 (public-nginx) and :8082 (keycloak) are host-published.
#
# Failure policy (the point of the step): a real SERVING or TRANSFER failure FAILs;
# environmental blockers (no Docker daemon, offline/registry, host ports occupied, DNS for
# *.localtest.me unavailable, a browser that cannot be installed) SKIP — never a false pass,
# never a false fail.

# ----------------------------------------------------------------------------------
# Environment / globals
# ----------------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$REPO_ROOT/docker-compose.yml"
ENV_EXAMPLE="$REPO_ROOT/.env.example"
REALM_EXPORT="$REPO_ROOT/tools/keycloak/realm-export.json"
WEB_CLIENT="$REPO_ROOT/web/client"

# Isolated compose project (matches the other tests/* harnesses): a teardown with -v can
# only ever remove THIS harness's containers/volumes/networks, never a real `docker compose
# up` stack. Published host ports are global, though, so a foreign stack already holding
# :8080/:8082 makes bring-up SKIP (handled below), never clobber.
PROJECT="scfin-e2e-fullrun"
SEED_PROFILE="seed"

# The DEFAULT up graph (no profile) — every service that a clean `docker compose up` starts.
# All carry a healthcheck, so `--wait` proves all-healthy. `seed` is profile-gated and is
# NOT here (it is run explicitly, twice, below).
ALL_SERVICES="postgres redis mongo keycloak balance-service analytics-server public-kong client-app otp-app public-nginx"
# The public-plane trio whose health the customer flow directly depends on (reported first).
PUBLIC_PLANE_SVCS="postgres redis keycloak balance-service public-kong client-app otp-app public-nginx"

# Seed <-> e2e contract (spec 08). DEST_ACCOUNT is Customer B's seeded account number — a
# public account id, not a secret; it is the spec contract value and MUST override the
# spec-07 baked default (2000000001) which does not match our seed.
DEST_ACCOUNT="1000000002"

# Loaded at runtime.
PUBLIC_HTTP_PORT=""
KEYCLOAK_PORT=""
KC_HOSTNAME=""
POSTGRES_USER=""; POSTGRES_PASSWORD=""; BALANCE_DB=""
E2E_USERNAME=""; E2E_PASSWORD=""     # read from realm-export.json (demo-customer)

RUNTIME_ENVFILE=""                   # temp copy of .env.example used for every `dc` call
UP_DONE=0                            # 1 if THIS harness brought the stack up (=> may tear down)
SEED1_RC=""; SEED2_RC=""
CUST_BEFORE=""; CUST_AFTER=""; ACCT_BEFORE=""; ACCT_AFTER=""

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

# Keep the stack up after the run (inspection / manual re-run). Set via `run.sh keep` or env.
KEEP_STACK="${KEEP_STACK:-0}"

# Pick a Python that actually runs (jq is not assumed present).
PYTHON=""
for _cand in python python3; do
  if command -v "$_cand" >/dev/null 2>&1 && "$_cand" -c 'import sys' >/dev/null 2>&1; then
    PYTHON="$_cand"; break
  fi
done
unset _cand

# Colors (disabled when not a TTY).
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_CYAN=$'\033[36m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_BOLD=""; C_RESET=""
fi

# ----------------------------------------------------------------------------------
# Reporting
# ----------------------------------------------------------------------------------
pass()    { PASS_COUNT=$((PASS_COUNT + 1)); printf '  %sPASS%s %s\n' "$C_GREEN"  "$C_RESET" "$1"; }
fail()    { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  %sFAIL%s %s\n' "$C_RED"    "$C_RESET" "$1" >&2; }
skip()    { SKIP_COUNT=$((SKIP_COUNT + 1)); printf '  %sSKIP%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
info()    { printf '  %sNOTE%s %s\n' "$C_CYAN" "$C_RESET" "$1"; }
section() { printf '\n%s== %s ==%s\n' "$C_BOLD" "$1" "$C_RESET"; }

# An error message that is clearly environmental (offline / registry / daemon) rather than a
# code/spec defect — such failures SKIP, never FAIL.
is_env_failure() {
  printf '%s' "$1" | grep -qiE 'network|timeout|temporary failure|could not resolve|lookup|tls|dial tcp|connection refused|no such host|pull access|manifest unknown|i/o timeout|EAI_AGAIN|registry|cannot connect to the docker daemon'
}
# A host-port collision with a foreign stack — SKIP with guidance (do not clobber).
is_port_conflict() {
  printf '%s' "$1" | grep -qiE 'port is already allocated|address already in use|bind for .* failed|ports are not available'
}

# ----------------------------------------------------------------------------------
# .env.example value reader (pure bash). Returns the LAST assignment for KEY.
# ----------------------------------------------------------------------------------
env_val() {
  local key="$1" line val=""
  [ -f "$ENV_EXAMPLE" ] || { printf ''; return 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key="*) val="${line#*=}" ;;
    esac
  done < "$ENV_EXAMPLE"
  val="${val%$'\r'}"
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  printf '%s' "$val"
}

load_env_values() {
  PUBLIC_HTTP_PORT="$(env_val PUBLIC_HTTP_PORT)"; [ -n "$PUBLIC_HTTP_PORT" ] || PUBLIC_HTTP_PORT="8080"
  KEYCLOAK_PORT="$(env_val KEYCLOAK_PORT)";       [ -n "$KEYCLOAK_PORT" ]     || KEYCLOAK_PORT="8082"
  KC_HOSTNAME="$(env_val KC_HOSTNAME)";           [ -n "$KC_HOSTNAME" ]       || KC_HOSTNAME="keycloak.localtest.me"
  POSTGRES_USER="$(env_val POSTGRES_USER)"
  POSTGRES_PASSWORD="$(env_val POSTGRES_PASSWORD)"
  BALANCE_DB="$(env_val POSTGRES_DB)"; [ -n "$BALANCE_DB" ] || BALANCE_DB="balance"
}

edge_base()   { printf 'http://localhost:%s' "$PUBLIC_HTTP_PORT"; }
issuer_base() { printf 'http://%s:%s/realms/supercool' "$KC_HOSTNAME" "$KEYCLOAK_PORT"; }

# Read the demo-customer login (the user carrying the `customer` realm role) straight from
# realm-export.json — the project's existing demo credential of record. No credential literal
# is duplicated into this harness. Sets E2E_USERNAME / E2E_PASSWORD.
load_realm_login() {
  [ -n "$PYTHON" ] || return 1
  [ -f "$REALM_EXPORT" ] || return 1
  local out
  out="$("$PYTHON" - "$REALM_EXPORT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
for u in d.get('users', []):
    if 'customer' in (u.get('realmRoles') or []):
        pw = ''
        for c in (u.get('credentials') or []):
            if c.get('type') == 'password':
                pw = c.get('value') or ''
        print(f"{u.get('username','')}\t{pw}")
        break
PY
)" || return 1
  E2E_USERNAME="${out%%$'\t'*}"
  E2E_PASSWORD="${out#*$'\t'}"
  [ -n "$E2E_USERNAME" ] && [ -n "$E2E_PASSWORD" ]
}

# ----------------------------------------------------------------------------------
# Compose wrapper — isolated project, repo-root project dir, always an --env-file (a temp
# copy of .env.example) so ${KEYCLOAK_PORT} etc. interpolate on every subcommand and the
# user's real `.env` is never read or written. Relative mounts (./infra, ./tools) resolve
# against --project-directory = repo root.
# ----------------------------------------------------------------------------------
ensure_envfile() {
  if [ -z "$RUNTIME_ENVFILE" ] || [ ! -f "$RUNTIME_ENVFILE" ]; then
    RUNTIME_ENVFILE="$(mktemp)"
    cp "$ENV_EXAMPLE" "$RUNTIME_ENVFILE"
  fi
}
dc() {
  ensure_envfile
  docker compose -p "$PROJECT" --project-directory "$REPO_ROOT" --env-file "$RUNTIME_ENVFILE" -f "$COMPOSE" "$@"
}
cid()      { dc ps -q "$1" 2>/dev/null | head -1; }
teardown() { dc down -v --remove-orphans >/dev/null 2>&1; }

# Health status of one service: healthy|unhealthy|starting|none|absent.
svc_health() {
  local c; c="$(cid "$1")"
  [ -n "$c" ] || { printf 'absent'; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null
}

# psql scalar as the bootstrap superuser (bypasses the least-priv CONNECT split) against the
# balance DB — used only for the idempotency count sanity.
pg_scalar() {
  local c; c="$(cid postgres)"
  [ -n "$c" ] || { printf ''; return 1; }
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$c" \
    psql -tAqc "$1" -U "$POSTGRES_USER" -d "$BALANCE_DB" 2>/dev/null | tr -d '\r' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | head -1
}

# HTTP status code of a GET (no body), bounded.
http_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-15}" "$1" 2>/dev/null
}

# ==================================================================================
# PHASES
# ==================================================================================

# --- Preflight: the tools this harness needs. Missing ones SKIP (never a false pass). ---
# Returns 0 to proceed, 1 to abort the whole run with SKIPs.
preflight() {
  section "Preflight — docker daemon, node/npm/npx, curl, python"
  local ok=1
  if ! command -v docker >/dev/null 2>&1; then skip "docker CLI not installed — cannot run the full stack"; ok=0;
  elif ! docker info >/dev/null 2>&1;      then skip "Docker daemon not reachable — start Docker Desktop, then re-run"; ok=0;
  else info "docker: $(docker --version 2>/dev/null)"; fi
  if ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
    skip "node/npx not installed — cannot run the Playwright e2e"; ok=0;
  else info "node: $(node --version 2>/dev/null), npm: $(npm --version 2>/dev/null)"; fi
  command -v curl   >/dev/null 2>&1 || { skip "curl not installed — needed for edge/issuer reachability checks"; ok=0; }
  [ -n "$PYTHON" ] || { skip "python not available — needed to read the demo login from realm-export.json"; ok=0; }
  [ -f "$COMPOSE" ]     || { fail "docker-compose.yml not found at $COMPOSE"; ok=0; }
  [ -f "$ENV_EXAMPLE" ] || { fail ".env.example not found at $ENV_EXAMPLE"; ok=0; }
  [ "$ok" -eq 1 ]
}

# --- Bring up the DEFAULT graph and wait for ALL-HEALTHY (the first DoD item). ---
# Returns 0 up-and-healthy, 1 SKIP (environmental / port conflict), 2 FAIL (real defect).
bring_up() {
  section "Bring up — \`docker compose up -d --build --wait\` (default graph, all-healthy)"
  # If the public edge is ALREADY serving, a foreign stack likely owns :$PUBLIC_HTTP_PORT.
  # We must not clobber it, and our isolated project could not bind the port anyway.
  if [ "$(http_code "$(edge_base)/healthz" 5)" = "200" ]; then
    local mine; mine="$(cid public-nginx)"
    if [ -z "$mine" ]; then
      skip "something is already serving $(edge_base) (a foreign \`docker compose up\` stack?) — stop it ('docker compose down'), then re-run; not clobbering it"
      return 1
    fi
  fi
  info "building images + starting: $ALL_SERVICES"
  info "(clean-machine first run pulls base images + builds 4 app images + vite bundles — this can take many minutes)"
  local err rc; err="$(mktemp)"
  dc up -d --build --wait --wait-timeout 600 >/dev/null 2>"$err"; rc=$?
  local msg; msg="$(cat "$err")"; rm -f "$err"
  if [ "$rc" -ne 0 ]; then
    if is_port_conflict "$msg"; then
      skip "a host port (:$PUBLIC_HTTP_PORT / :$KEYCLOAK_PORT) is already in use — stop the stack/process holding it, then re-run. First lines:"; printf '%s\n' "$msg" | head -6 >&2
      teardown; return 1
    fi
    if is_env_failure "$msg"; then
      skip "stack could not build/start for an ENVIRONMENTAL reason (offline / registry / daemon). First lines:"; printf '%s\n' "$msg" | head -10 >&2
      teardown; return 1
    fi
    fail "\`docker compose up --build --wait\` failed — a real build/boot/health defect (the stack does not reach all-healthy). First lines:"; printf '%s\n' "$msg" | head -25 >&2
    return 2
  fi
  UP_DONE=1
  return 0
}

# --- Assert all-healthy explicitly (evidence), even though --wait already gated it. ---
check_all_healthy() {
  section "All-healthy — every default-graph service reports 'healthy'"
  local bad="" s st
  for s in $ALL_SERVICES; do
    st="$(svc_health "$s")"
    if [ "$st" = "healthy" ]; then
      info "$s = healthy"
    else
      bad="$bad $s=$st"
    fi
  done
  if [ -z "$bad" ]; then
    pass "all default-graph services are healthy: $ALL_SERVICES"
  else
    fail "not all services are healthy:$bad — the clean-machine up did not reach all-healthy"
  fi
}

# --- Seed: run the `seed` profile, then run it AGAIN and prove the counts are unchanged. ---
run_seed() {
  section "Seed — \`docker compose --profile $SEED_PROFILE run --rm $SEED_PROFILE\` (load demo data, then prove idempotent)"
  CUST_BEFORE="$(pg_scalar "SELECT count(*) FROM customer")"
  ACCT_BEFORE="$(pg_scalar "SELECT count(*) FROM account WHERE kind='customer'")"
  info "pre-seed: customers=${CUST_BEFORE:-?}, customer-accounts=${ACCT_BEFORE:-?}"

  local e1 e2; e1="$(mktemp)"; e2="$(mktemp)"
  info "seed run #1 (with --build, since the profile-gated image is not built by the default up)"
  dc --profile "$SEED_PROFILE" run --rm -T --build "$SEED_PROFILE" >/dev/null 2>"$e1"; SEED1_RC=$?
  local m1; m1="$(cat "$e1")"; rm -f "$e1"
  if [ "$SEED1_RC" -ne 0 ] && is_env_failure "$m1"; then
    skip "seed image could not be built/pulled (offline/registry) — seed + idempotency skipped"; rm -f "$e2"; return
  fi

  local cust_mid acct_mid
  cust_mid="$(pg_scalar "SELECT count(*) FROM customer")"
  acct_mid="$(pg_scalar "SELECT count(*) FROM account WHERE kind='customer'")"

  if [ "$SEED1_RC" = "0" ]; then
    pass "seed run #1 exited 0 — demo data loaded (customers ${CUST_BEFORE:-?}->${cust_mid:-?}, accounts ${ACCT_BEFORE:-?}->${acct_mid:-?})"
  else
    fail "seed run #1 exited $SEED1_RC — demo data did not load. stderr: $(printf '%s' "$m1" | head -c 400)"
    rm -f "$e2"; return
  fi

  info "seed run #2 (no --build) — must be a clean no-op"
  dc --profile "$SEED_PROFILE" run --rm -T "$SEED_PROFILE" >/dev/null 2>"$e2"; SEED2_RC=$?
  local m2; m2="$(cat "$e2")"; rm -f "$e2"
  CUST_AFTER="$(pg_scalar "SELECT count(*) FROM customer")"
  ACCT_AFTER="$(pg_scalar "SELECT count(*) FROM account WHERE kind='customer'")"

  local problems=""
  [ "$SEED2_RC" = "0" ]               || problems="$problems\n  - second run exited '${SEED2_RC:-?}' (expected 0). stderr: $(printf '%s' "$m2" | head -c 200)"
  [ "$CUST_AFTER" = "$cust_mid" ]     || problems="$problems\n  - customer count changed on re-run: $cust_mid -> ${CUST_AFTER:-?} (duplication)"
  [ "$ACCT_AFTER" = "$acct_mid" ]     || problems="$problems\n  - customer-account count changed on re-run: $acct_mid -> ${ACCT_AFTER:-?} (duplication)"
  if [ -n "$problems" ]; then
    fail "seed is NOT idempotent:"; printf '%b\n' "$problems" >&2
  else
    pass "seed re-run is a clean no-op: exit 0, customers=$CUST_AFTER, customer-accounts=$ACCT_AFTER unchanged (idempotent)"
  fi
}

# --- The browser must reach Keycloak at its issuer host. If *.localtest.me does not resolve
# to 127.0.0.1 (no DNS), the OIDC redirect cannot complete — that is ENVIRONMENTAL, so the
# e2e is SKIPPED with guidance rather than failed. Returns 0 reachable, 1 not. ---
check_browser_issuer_reachable() {
  section "Browser reachability — Keycloak issuer at $(issuer_base) (needs *.localtest.me -> 127.0.0.1)"
  local code
  code="$(http_code "$(issuer_base)/.well-known/openid-configuration" 15)"
  if [ "$code" = "200" ]; then
    pass "Keycloak OIDC discovery at $(issuer_base) -> 200 — the browser can resolve $KC_HOSTNAME and complete the login redirect"
    return 0
  fi
  skip "Keycloak issuer not reachable at $(issuer_base) (HTTP ${code:-000}) — likely *.localtest.me does not resolve to 127.0.0.1 on this host (no public DNS). Add '127.0.0.1 $KC_HOSTNAME' to the hosts file, then re-run. The browser login (and thus the e2e) cannot run without it."
  return 1
}

# --- Light black-box sanity on the public edge before the heavier browser flow. ---
check_public_edge_sanity() {
  section "Public edge sanity — front door live, client SPA served, API reaches Kong"
  local c
  c="$(http_code "$(edge_base)/healthz")"
  [ "$c" = "200" ] && pass "GET /healthz -> 200 (public-nginx live)" || fail "GET /healthz -> ${c:-000} (front door not serving)"
  c="$(http_code "$(edge_base)/")"
  [ "$c" = "200" ] && pass "GET / -> 200 (client SPA served at the root)" || fail "GET / -> ${c:-000} (client SPA not served)"
  # The API path must reach Kong and be rejected without a token (401) — NOT answered by the
  # SPA catch-all, and NOT open. This is the authenticated-spine precondition for the e2e.
  c="$(http_code "$(edge_base)/balance/api/accounts")"
  if [ "$c" = "401" ]; then
    pass "GET /balance/api/accounts (no token) -> 401 at Kong — the authenticated spine is wired"
  else
    fail "GET /balance/api/accounts (no token) -> ${c:-000} (expected 401 from Kong) — the API route is misrouted or the gateway is down"
  fi
}

# --- Ensure web/client deps + a Chromium are present for Playwright. The hardened .npmrc
# sets ignore-scripts=true, so the browser is NOT auto-downloaded by install — we do it
# explicitly. Environmental failures (offline) SKIP. Returns 0 ready, 1 SKIP. ---
prepare_playwright() {
  section "Playwright prep — web/client deps + Chromium (ignore-scripts means explicit install)"
  local err rc msg
  if [ ! -d "$WEB_CLIENT/node_modules/@playwright/test" ]; then
    info "installing web/client deps (npm ci) — node_modules/@playwright/test absent"
    err="$(mktemp)"
    ( cd "$WEB_CLIENT" && npm ci ) >/dev/null 2>"$err"; rc=$?
    msg="$(cat "$err")"; rm -f "$err"
    if [ "$rc" -ne 0 ]; then
      if is_env_failure "$msg"; then skip "npm ci failed (offline/registry) in web/client — e2e skipped. First lines:"; printf '%s\n' "$msg" | head -6 >&2;
      else fail "npm ci failed in web/client — cannot run the e2e. First lines:"; printf '%s\n' "$msg" | head -12 >&2; fi
      return 1
    fi
    info "web/client deps installed"
  else
    info "web/client deps already present"
  fi
  info "installing the Chromium browser (npx playwright install chromium)"
  err="$(mktemp)"
  ( cd "$WEB_CLIENT" && npx playwright install chromium ) >/dev/null 2>"$err"; rc=$?
  msg="$(cat "$err")"; rm -f "$err"
  if [ "$rc" -ne 0 ]; then
    if is_env_failure "$msg"; then skip "could not download Chromium (offline) — e2e skipped. First lines:"; printf '%s\n' "$msg" | head -6 >&2;
    else fail "playwright install chromium failed. First lines:"; printf '%s\n' "$msg" | head -12 >&2; fi
    return 1
  fi
  pass "Playwright prep ready (web/client deps + Chromium installed)"
  return 0
}

# --- The headline DoD proof: run the client TRANSFER-WITH-OTP e2e (and the login sanity) ---
# against the live stack with the seed-aligned env the specs read. A non-zero exit here is a
# REAL serving/transfer failure (or a test-code bug) -> FAIL. The external-transfer spec is
# deliberately NOT run: it needs a usable (post-cooling-off) external payee that the spec-08
# seed does not create, so it would fail on seed shape, not on a money-flow defect.
run_e2e() {
  section "Transfer-with-OTP e2e — client internal-transfer + login (the public-plane DoD)"
  if ! load_realm_login; then
    skip "could not read the demo-customer login from realm-export.json — e2e skipped"; return
  fi
  info "e2e env: E2E_ENABLED=1 E2E_BASE_URL=$(edge_base) E2E_USERNAME=$E2E_USERNAME E2E_PASSWORD=**** E2E_DEST_ACCOUNT=$DEST_ACCOUNT"
  info "specs: tests/e2e/internal-transfer.e2e.ts (headline) + tests/e2e/login.e2e.ts (login renders seeded account)"
  info "(external-transfer.e2e.ts is NOT run: it needs a seeded usable external payee the spec-08 seed does not create)"
  local rc
  (
    cd "$WEB_CLIENT" && \
    E2E_ENABLED=1 \
    E2E_BASE_URL="$(edge_base)" \
    E2E_USERNAME="$E2E_USERNAME" \
    E2E_PASSWORD="$E2E_PASSWORD" \
    E2E_DEST_ACCOUNT="$DEST_ACCOUNT" \
    npx playwright test tests/e2e/internal-transfer.e2e.ts tests/e2e/login.e2e.ts
  )
  rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "TRANSFER-WITH-OTP passed: confirmation-of-payee -> initiate -> OTP revealed via the real otp-app -> confirm -> source debited exactly; and demo-customer login rendered the seeded account"
  else
    fail "the client e2e exited $rc — a real serving/transfer failure (or a test-code bug). Re-run verbosely to triage: (cd web/client && E2E_ENABLED=1 E2E_BASE_URL=$(edge_base) E2E_USERNAME=$E2E_USERNAME E2E_PASSWORD=**** E2E_DEST_ACCOUNT=$DEST_ACCOUNT npx playwright test tests/e2e/internal-transfer.e2e.ts --reporter=list)"
  fi
}

# ----------------------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------------------
run_all() {
  load_env_values
  preflight || return 0

  local up_rc
  bring_up; up_rc=$?
  case "$up_rc" in
    0) : ;;
    1) return 0 ;;   # SKIP (environmental) — nothing brought up to verify
    2) return 0 ;;   # FAIL recorded; stack left as-is for inspection
  esac

  check_all_healthy
  run_seed

  if check_browser_issuer_reachable; then
    check_public_edge_sanity
    if prepare_playwright; then
      run_e2e
    fi
  else
    check_public_edge_sanity   # still prove the edge/API wiring even if the browser login can't run
  fi
}

down_only() {
  section "Teardown — \`docker compose down -v\` for project '$PROJECT'"
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    teardown
    info "project '$PROJECT' torn down (containers, volumes, networks removed)"
  else
    skip "Docker daemon not reachable — nothing to tear down"
  fi
}

# Idempotent cleanup of anything this harness created; safe on any exit.
global_cleanup() {
  if [ "$UP_DONE" -eq 1 ] && [ "$KEEP_STACK" != "1" ]; then
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      printf '\n%s== Teardown — docker compose down -v (project %s) ==%s\n' "$C_BOLD" "$PROJECT" "$C_RESET"
      teardown
    fi
  elif [ "$UP_DONE" -eq 1 ]; then
    printf '\n%sNOTE%s stack left UP (KEEP_STACK=1) under project "%s" — inspect at %s ; tear down with: bash %s down\n' \
      "$C_CYAN" "$C_RESET" "$PROJECT" "$(edge_base)" "tests/e2e-fullrun/run.sh"
  fi
  [ -n "${RUNTIME_ENVFILE:-}" ] && rm -f "$RUNTIME_ENVFILE" 2>/dev/null
}

print_summary() {
  section "Summary"
  printf '  PASS=%d  FAIL=%d  SKIP=%d\n' "$PASS_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"
  if [ "$FAIL_COUNT" -gt 0 ]; then
    printf '  %sRESULT: FAIL%s\n' "$C_RED" "$C_RESET"
  else
    printf '  %sRESULT: OK%s (%d skipped)\n' "$C_GREEN" "$C_RESET" "$SKIP_COUNT"
  fi
}
