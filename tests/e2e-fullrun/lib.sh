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
# SCOPE (Pass 2 — admin plane added). This harness now ALSO proves the ADMIN plane's
# build & serve: internal-nginx / internal-kong / admin-app are in the DEFAULT up graph, so
# `up --wait` brings them up all-healthy. After the stack is up it asserts the admin SPA is
# served at :8081, the no-token admin API is a 401 at Kong (authenticated spine wired), a
# real demo-admin bearer reaches /balance/admin/whoami -> 200 with the `admin` role, and it
# ENABLES + runs the admin app's login.e2e.ts browser chain (PKCE at :8081). Only :8080
# (public-nginx), :8081 (internal-nginx) and :8082 (keycloak) are host-published.
#
# KNOWN GAP (not proven here): the admin maker-checker reversal e2e (the reversal UI is not
# built) and the admin /accounts + /limits screens (their GET /admin/accounts + GET
# /admin/limits endpoints do not exist yet). So the admin browser chain runs ONLY
# login.e2e.ts (the whoami landing) — never accounts.e2e.ts.
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
WEB_ADMIN="$REPO_ROOT/web/admin"

# Coordination contract for the admin-plane PKCE mint (spec 02 / spec 06).
KC_REALM="supercool"
ADMIN_ROLE="admin"
PREFERRED_ADMIN_CLIENT="admin-app"   # the admin SPA's public client (:8081 redirect, aud=supercool-api)
# Admin SPA index discriminator — from the committed web/admin/index.html
# (<title>SuperCool Finances — Admin</title>); the ASCII-safe "Admin</title>" suffix
# uniquely tells it apart from the client ("SuperCool Finances") and otp titles.
ADMIN_TITLE_MARK='Admin</title>'
SPA_ROOT_MARK='id="root"'

# Isolated compose project (matches the other tests/* harnesses): a teardown with -v can
# only ever remove THIS harness's containers/volumes/networks, never a real `docker compose
# up` stack. Published host ports are global, though, so a foreign stack already holding
# :8080/:8082 makes bring-up SKIP (handled below), never clobber.
PROJECT="scfin-e2e-fullrun"
SEED_PROFILE="seed"

# The DEFAULT up graph (no profile) — every service that a clean `docker compose up` starts.
# All carry a healthcheck, so `--wait` proves all-healthy. `seed` is profile-gated and is
# NOT here (it is run explicitly, twice, below). Pass 2 adds the internal-edge trio
# (internal-kong, internal-nginx, admin-app) — now in the default graph, so `up --wait`
# reaches all-healthy on them too.
ALL_SERVICES="postgres redis mongo keycloak balance-service analytics-server public-kong client-app otp-app public-nginx internal-kong internal-nginx admin-app"

# Seed <-> e2e contract (spec 08). DEST_ACCOUNT is Customer B's seeded account number — a
# public account id, not a secret; it is the spec contract value and MUST override the
# spec-07 baked default (2000000001) which does not match our seed.
DEST_ACCOUNT="1000000002"

# Loaded at runtime.
PUBLIC_HTTP_PORT=""
INTERNAL_HTTP_PORT=""
KEYCLOAK_PORT=""
KC_HOSTNAME=""
POSTGRES_USER=""; POSTGRES_PASSWORD=""; BALANCE_DB=""
E2E_USERNAME=""; E2E_PASSWORD=""             # read from realm-export.json (demo-customer)
E2E_ADMIN_USERNAME=""; E2E_ADMIN_PASSWORD="" # read from realm-export.json (demo-admin)
ADMIN_TOKEN=""; ADMIN_SUB=""                 # minted demo-admin access token + its sub (black-box whoami slice)
PKCE_SCRIPT=""                               # temp path of the scripted PKCE flow

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
  PUBLIC_HTTP_PORT="$(env_val PUBLIC_HTTP_PORT)";     [ -n "$PUBLIC_HTTP_PORT" ]   || PUBLIC_HTTP_PORT="8080"
  INTERNAL_HTTP_PORT="$(env_val INTERNAL_HTTP_PORT)"; [ -n "$INTERNAL_HTTP_PORT" ] || INTERNAL_HTTP_PORT="8081"
  KEYCLOAK_PORT="$(env_val KEYCLOAK_PORT)";           [ -n "$KEYCLOAK_PORT" ]      || KEYCLOAK_PORT="8082"
  KC_HOSTNAME="$(env_val KC_HOSTNAME)";               [ -n "$KC_HOSTNAME" ]        || KC_HOSTNAME="keycloak.localtest.me"
  POSTGRES_USER="$(env_val POSTGRES_USER)"
  POSTGRES_PASSWORD="$(env_val POSTGRES_PASSWORD)"
  BALANCE_DB="$(env_val POSTGRES_DB)"; [ -n "$BALANCE_DB" ] || BALANCE_DB="balance"
}

edge_base()        { printf 'http://localhost:%s' "$PUBLIC_HTTP_PORT"; }
internal_base()    { printf 'http://localhost:%s' "$INTERNAL_HTTP_PORT"; }
admin_whoami_url() { printf '%s/balance/admin/whoami' "$(internal_base)"; }
issuer_base()      { printf 'http://%s:%s/realms/supercool' "$KC_HOSTNAME" "$KEYCLOAK_PORT"; }
alias_base()       { printf 'http://%s:%s' "$KC_HOSTNAME" "$KEYCLOAK_PORT"; }

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

# Read the demo-admin login (the user carrying the `admin` realm role) straight from
# realm-export.json — same source of record as the customer login. Sets
# E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD.
load_realm_admin_login() {
  [ -n "$PYTHON" ] || return 1
  [ -f "$REALM_EXPORT" ] || return 1
  local out
  out="$("$PYTHON" - "$REALM_EXPORT" "$ADMIN_ROLE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
role = sys.argv[2]
for u in d.get('users', []):
    if role in (u.get('realmRoles') or []):
        pw = ''
        for c in (u.get('credentials') or []):
            if c.get('type') == 'password':
                pw = c.get('value') or ''
        print(f"{u.get('username','')}\t{pw}")
        break
PY
)" || return 1
  E2E_ADMIN_USERNAME="${out%%$'\t'*}"
  E2E_ADMIN_PASSWORD="${out#*$'\t'}"
  [ -n "$E2E_ADMIN_USERNAME" ] && [ -n "$E2E_ADMIN_PASSWORD" ]
}

# ----------------------------------------------------------------------------------
# Admin-plane PKCE token mint — a REAL Authorization-Code + PKCE (S256) login for the
# seeded demo-admin user, used for the BLACK-BOX admin whoami slice (browser-independent).
# Same scripted choreography as tests/transport; no credential literal is baked in — the
# user + client + redirect are recovered from realm-export.json. Needs the host to resolve
# KC_HOSTNAME -> loopback (localtest.me does over public DNS); returns 1 (caller SKIPs) when
# it cannot mint headlessly — never a false pass.
# ----------------------------------------------------------------------------------
host_resolves_alias() {
  [ -n "$PYTHON" ] || return 1
  "$PYTHON" - "$KC_HOSTNAME" <<'PY'
import socket, sys
try:
    ip = socket.gethostbyname(sys.argv[1])
except Exception:
    sys.exit(1)
sys.exit(0 if ip.startswith("127.") or ip == "0.0.0.0" else 1)
PY
}

decode_jwt_sub() {  # $1 = access token -> prints the sub claim
  [ -n "$PYTHON" ] || return 1
  "$PYTHON" - "$1" <<'PY'
import sys, json, base64
parts = sys.argv[1].split('.')
if len(parts) < 2: sys.exit(1)
seg = parts[1]; seg += '=' * (-len(seg) % 4)
try:
    payload = json.loads(base64.urlsafe_b64decode(seg.encode()).decode('utf-8'))
except Exception:
    sys.exit(1)
print(payload.get('sub',''))
PY
}

write_pkce_script() {
  [ -n "$PKCE_SCRIPT" ] && [ -f "$PKCE_SCRIPT" ] && return 0
  PKCE_SCRIPT="$(mktemp)"
  cat > "$PKCE_SCRIPT" <<'PY'
import sys, json, base64, hashlib, secrets, re, html
import urllib.parse, urllib.request, urllib.error, http.cookiejar

base, realm, client_id, redirect_uri, username, password = sys.argv[1:7]

def b64url(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
verifier = b64url(secrets.token_bytes(40))
challenge = b64url(hashlib.sha256(verifier.encode()).digest())
state = secrets.token_hex(8)

auth_ep  = f"{base}/realms/{realm}/protocol/openid-connect/auth"
token_ep = f"{base}/realms/{realm}/protocol/openid-connect/token"

cj = http.cookiejar.CookieJar()

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

follow   = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
nofollow = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj), NoRedirect)

q = urllib.parse.urlencode({
    "client_id": client_id, "response_type": "code", "scope": "openid",
    "redirect_uri": redirect_uri, "state": state,
    "code_challenge": challenge, "code_challenge_method": "S256",
})
try:
    page = follow.open(auth_ep + "?" + q, timeout=30).read().decode("utf-8", "replace")
except urllib.error.URLError as e:
    print(f"auth GET failed: {e}", file=sys.stderr); sys.exit(1)

m = (re.search(r'id="kc-form-login"[^>]*\baction="([^"]+)"', page)
     or re.search(r'\baction="([^"]+)"[^>]*id="kc-form-login"', page)
     or re.search(r'action="([^"]*login-actions/authenticate[^"]*)"', page))
if not m:
    print("could not locate the Keycloak login form action", file=sys.stderr); sys.exit(1)
action = html.unescape(m.group(1))

form = urllib.parse.urlencode({"username": username, "password": password, "credentialId": ""}).encode()
FORM_CT = {"Content-Type": "application/x-www-form-urlencoded"}
try:
    resp = nofollow.open(urllib.request.Request(action, data=form, headers=FORM_CT), timeout=30)
    print("login POST did not redirect (HTTP %s) => bad credentials or a required action" % resp.getcode(), file=sys.stderr)
    sys.exit(1)
except urllib.error.HTTPError as e:
    if e.code not in (301, 302, 303, 307, 308):
        print(f"login POST error HTTP {e.code}: {e.read().decode('utf-8','replace')[:300]}", file=sys.stderr)
        sys.exit(1)
    location = e.headers.get("Location", "")

params = urllib.parse.parse_qs(urllib.parse.urlparse(location).query)
if "code" not in params:
    print(f"no 'code' in redirect Location: {location}", file=sys.stderr); sys.exit(1)
code = params["code"][0]

exch = urllib.parse.urlencode({
    "grant_type": "authorization_code", "code": code,
    "redirect_uri": redirect_uri, "client_id": client_id, "code_verifier": verifier,
}).encode()
try:
    tok = urllib.request.urlopen(urllib.request.Request(token_ep, data=exch, headers=FORM_CT), timeout=30).read().decode()
except urllib.error.HTTPError as e:
    print(f"token exchange failed HTTP {e.code}: {e.read().decode('utf-8','replace')[:300]}", file=sys.stderr)
    sys.exit(1)
at = json.loads(tok).get("access_token")
if not at:
    print(f"token response had no access_token: {tok[:200]}", file=sys.stderr); sys.exit(1)
print(at)
PY
}

mint_admin_token() {
  [ -n "$ADMIN_TOKEN" ] && return 0
  [ -n "$PYTHON" ] || return 1
  [ -f "$REALM_EXPORT" ] || return 1
  host_resolves_alias || return 1
  local trip user pass client redirect token errf
  trip="$("$PYTHON" - "$REALM_EXPORT" "$ADMIN_ROLE" "$PREFERRED_ADMIN_CLIENT" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding='utf-8'))
role, preferred = sys.argv[2], sys.argv[3]
def plaintext_pw(u):
    for c in (u.get("credentials") or []):
        if c.get("type") == "password" and c.get("value") and not c.get("hashedSaltedValue"):
            return c.get("value")
    return None
user = None
for u in (doc.get("users") or []):
    if role in (u.get("realmRoles") or []) and plaintext_pw(u) and u.get("enabled", True):
        if u.get("requiredActions"): continue
        user = u; break
if not user:
    print(""); sys.exit(0)
clients = {c.get("clientId"): c for c in (doc.get("clients") or [])}
order = [preferred] + [c for c in clients if c != preferred]
redirect = chosen = None
for cid in order:
    c = clients.get(cid)
    if not c or c.get("standardFlowEnabled") is False: continue
    for ru in (c.get("redirectUris") or []):
        r = ru
        if r.endswith("/*"): r = r[:-1]
        elif r.endswith("*"): r = r[:-1]
        redirect = r; chosen = cid; break
    if redirect: break
if not redirect:
    print(""); sys.exit(0)
print("\t".join([user.get("username",""), plaintext_pw(user), chosen, redirect]))
PY
)"
  [ -n "$trip" ] || return 1
  IFS=$'\t' read -r user pass client redirect <<EOF
$trip
EOF
  write_pkce_script
  errf="$(mktemp)"
  token="$("$PYTHON" "$PKCE_SCRIPT" "$(alias_base)" "$KC_REALM" "$client" "$redirect" "$user" "$pass" 2>"$errf")"
  if [ -z "$token" ]; then
    info "PKCE mint for '$user' did not yield a token: $(head -c 200 "$errf")"; rm -f "$errf"; return 1
  fi
  rm -f "$errf"
  ADMIN_TOKEN="$token"
  ADMIN_SUB="$(decode_jwt_sub "$token")"
  return 0
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

# --- Light black-box sanity on the ADMIN (internal) edge. Proves the internal front door is
# live, the admin SPA is served at :8081, and the admin API reaches Kong (no-token -> 401,
# NOT answered by the `/` SPA catch-all). Mirrors check_public_edge_sanity for the admin plane. ---
check_admin_edge_sanity() {
  section "Admin edge sanity — internal front door live, admin SPA served at :$INTERNAL_HTTP_PORT, admin API reaches Kong"
  local c body
  c="$(http_code "$(internal_base)/healthz")"
  [ "$c" = "200" ] && pass "GET :$INTERNAL_HTTP_PORT/healthz -> 200 (internal-nginx live)" || fail "GET :$INTERNAL_HTTP_PORT/healthz -> ${c:-000} (internal front door not serving)"
  # GET / must serve the admin SPA index (the `/` catch-all now routes to admin-app, not the 404 placeholder).
  body="$(curl -s --max-time 15 "$(internal_base)/" 2>/dev/null)"
  case "$body" in
    *"$ADMIN_TITLE_MARK"*) pass "GET :$INTERNAL_HTTP_PORT/ -> the admin SPA index served (title contains 'Admin', root mount node)" ;;
    *"$SPA_ROOT_MARK"*)    fail "GET :$INTERNAL_HTTP_PORT/ served a SPA index but NOT the admin one (no 'Admin' <title>) — the root is misrouted to the wrong bundle" ;;
    *)                     fail "GET :$INTERNAL_HTTP_PORT/ did not serve the admin SPA index (still the 404 placeholder or admin-app down). Body head: $(printf '%s' "$body" | head -c 160)" ;;
  esac
  # No-token admin API must reach Kong and be rejected with 401 — NOT answered by the SPA
  # catch-all, and NOT open. This is the authenticated-spine precondition for the admin flow.
  c="$(http_code "$(admin_whoami_url)")"
  if [ "$c" = "401" ]; then
    pass "no-token GET /balance/admin/whoami -> 401 at internal-kong — the admin API is not shadowed by the / catch-all and the authenticated spine is wired"
  else
    fail "no-token GET /balance/admin/whoami -> ${c:-000} (expected 401 from Kong) — the admin API is misrouted, shadowed by the SPA catch-all, or the internal gateway is down"
  fi
}

# --- The admin-plane PROOF (black-box, browser-independent): a REAL demo-admin bearer ->
# GET /balance/admin/whoami -> 200 with { userId==sub, roles contains 'admin' }. Proves the
# demo-admin login reaches balance-service through internal-nginx -> internal-kong (JWT
# verified, admin gate, /balance stripped, identity injected). SKIPs if a token cannot be
# minted headlessly (no *.localtest.me DNS / Keycloak down); FAILs on a 401/403 for a valid
# admin, or a wrong echoed identity. ---
check_admin_whoami_slice() {
  section "Admin whoami slice — demo-admin bearer -> GET /balance/admin/whoami -> 200, userId==sub, roles has '$ADMIN_ROLE'"
  if ! mint_admin_token; then
    skip "could not mint a demo-admin token headlessly (Keycloak unreachable / no *.localtest.me DNS) — admin whoami slice skipped; the browser login.e2e.ts still proves it if it runs"
    return
  fi
  local tmpd code body
  tmpd="$(mktemp -d)"
  code="$(curl -s --max-time 20 -o "$tmpd/body" -w '%{http_code}' -H "Authorization: Bearer $ADMIN_TOKEN" "$(admin_whoami_url)" 2>/dev/null)"
  body="$(cat "$tmpd/body" 2>/dev/null)"; rm -rf "$tmpd"
  case "$code" in
    200)
      if "$PYTHON" - "$ADMIN_SUB" "$ADMIN_ROLE" "$body" <<'PY'
import sys, json
sub, role, body = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.loads(body)
except Exception as e:
    print(f"  -> whoami body is not JSON: {e} | {body[:160]}"); sys.exit(1)
bad = False
if d.get("userId") == sub and sub:
    print(f"  userId == token sub ('{sub}')")
else:
    print(f"  -> userId '{d.get('userId')}' != token sub '{sub}'"); bad = True
roles = d.get("roles") or []
if isinstance(roles, str): roles = [roles]
if role in roles:
    print(f"  roles contains '{role}' (roles: {roles})")
else:
    print(f"  -> roles does NOT contain '{role}' (got {roles})"); bad = True
sys.exit(1 if bad else 0)
PY
      then pass "demo-admin bearer -> /balance/admin/whoami 200 with userId==sub and roles including '$ADMIN_ROLE' (reached balance-service through internal-nginx -> internal-kong)"
      else fail "whoami 200 but the echoed identity is wrong (internal-kong injected the wrong X-User-Id/X-Roles, or the wrong upstream answered)"
      fi
      ;;
    401|403)
      fail "GET /balance/admin/whoami with a VALID demo-admin bearer -> HTTP $code — the internal edge rejected an admin (JWKS/iss/aud/admin-role gate misconfigured). Body: $(printf '%s' "$body" | head -c 160)" ;;
    *)
      fail "GET /balance/admin/whoami (admin bearer) -> HTTP ${code:-000} (expected 200) — the admin token did not reach balance-service. Body: $(printf '%s' "$body" | head -c 160)" ;;
  esac
}

# --- Ensure web/admin deps + a Chromium are present for the admin Playwright chain (same
# ignore-scripts handling as prepare_playwright; the Chromium download is shared, so it is
# a no-op if the client prep already fetched it). Returns 0 ready, 1 SKIP. ---
prepare_playwright_admin() {
  section "Admin Playwright prep — web/admin deps + Chromium"
  local err rc msg
  if [ ! -d "$WEB_ADMIN/node_modules/@playwright/test" ]; then
    info "installing web/admin deps (npm ci) — node_modules/@playwright/test absent"
    err="$(mktemp)"
    ( cd "$WEB_ADMIN" && npm ci ) >/dev/null 2>"$err"; rc=$?
    msg="$(cat "$err")"; rm -f "$err"
    if [ "$rc" -ne 0 ]; then
      if is_env_failure "$msg"; then skip "npm ci failed (offline/registry) in web/admin — admin e2e skipped. First lines:"; printf '%s\n' "$msg" | head -6 >&2;
      else fail "npm ci failed in web/admin — cannot run the admin e2e. First lines:"; printf '%s\n' "$msg" | head -12 >&2; fi
      return 1
    fi
    info "web/admin deps installed"
  else
    info "web/admin deps already present"
  fi
  info "installing the Chromium browser (npx playwright install chromium)"
  err="$(mktemp)"
  ( cd "$WEB_ADMIN" && npx playwright install chromium ) >/dev/null 2>"$err"; rc=$?
  msg="$(cat "$err")"; rm -f "$err"
  if [ "$rc" -ne 0 ]; then
    if is_env_failure "$msg"; then skip "could not download Chromium (offline) — admin e2e skipped. First lines:"; printf '%s\n' "$msg" | head -6 >&2;
    else fail "playwright install chromium failed (web/admin). First lines:"; printf '%s\n' "$msg" | head -12 >&2; fi
    return 1
  fi
  pass "Admin Playwright prep ready (web/admin deps + Chromium installed)"
  return 0
}

# --- The admin-plane DoD spine: ENABLE + run the admin app's login.e2e.ts browser chain
# (PKCE at :8081 -> whoami landing renders the gateway-resolved admin identity). This is the
# admin analog of how 8-C enabled the client chain: flip E2E_ENABLED on and feed the demo-admin
# creds + the :8081 origin. Only login.e2e.ts is run — accounts.e2e.ts is NOT (its GET
# /admin/accounts + /admin/limits reads do not exist yet; that screen is not functional against
# the real backend). A non-zero exit is a REAL serving/auth failure (or a test-code bug) -> FAIL. ---
run_admin_e2e() {
  section "Admin login e2e — PKCE at :$INTERNAL_HTTP_PORT -> whoami landing renders the admin identity (the admin-plane proof)"
  if ! load_realm_admin_login; then
    skip "could not read the demo-admin login from realm-export.json — admin e2e skipped"; return
  fi
  info "e2e env: E2E_ENABLED=1 E2E_BASE_URL=$(internal_base)/ E2E_USERNAME=$E2E_ADMIN_USERNAME E2E_PASSWORD=****"
  info "spec: tests/e2e/login.e2e.ts (admin PKCE login + GET /balance/admin/whoami renders 'Admin console' + admin role)"
  info "(accounts.e2e.ts is NOT run: its GET /admin/accounts + /admin/limits reads do not exist yet — the screen is not functional against the real backend)"
  local rc
  (
    cd "$WEB_ADMIN" && \
    E2E_ENABLED=1 \
    E2E_BASE_URL="$(internal_base)/" \
    E2E_USERNAME="$E2E_ADMIN_USERNAME" \
    E2E_PASSWORD="$E2E_ADMIN_PASSWORD" \
    npx playwright test tests/e2e/login.e2e.ts
  )
  rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "ADMIN LOGIN passed: demo-admin PKCE login at :$INTERNAL_HTTP_PORT -> GET /balance/admin/whoami 200 through internal-nginx -> internal-kong -> balance-service -> the admin identity (role 'admin') renders on 'Admin console'"
  else
    fail "the admin login e2e exited $rc — a real serving/auth failure (or a test-code bug). Re-run verbosely: (cd web/admin && E2E_ENABLED=1 E2E_BASE_URL=$(internal_base)/ E2E_USERNAME=$E2E_ADMIN_USERNAME E2E_PASSWORD=**** npx playwright test tests/e2e/login.e2e.ts --reporter=list)"
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

  # The browser issuer must resolve for EITHER browser chain (client + admin) to run; check once.
  local issuer_ok=1
  check_browser_issuer_reachable || issuer_ok=0

  # --- PUBLIC plane (transfer-with-OTP) ---
  check_public_edge_sanity
  if [ "$issuer_ok" -eq 1 ] && prepare_playwright; then
    run_e2e
  fi

  # --- ADMIN plane (whoami landing reached through internal-nginx -> internal-kong) ---
  check_admin_edge_sanity
  check_admin_whoami_slice
  if [ "$issuer_ok" -eq 1 ] && prepare_playwright_admin; then
    run_admin_e2e
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
  [ -n "${PKCE_SCRIPT:-}" ]     && rm -f "$PKCE_SCRIPT" 2>/dev/null
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
