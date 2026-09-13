#!/usr/bin/env bash
# lib.sh — shared helpers and all verification checks for the ADMIN-PLANE
# BUILD-AND-SERVE step of spec 08 (Pass 2). Sourced by run.sh; defines functions
# only, never exits.
#
# Checks are written FROM the spec (specs/08-build-and-serve.md — "Frontend build" /
# the internal-nginx router paragraph, "Full run", the "Definition of Done" and its
# "Scope note — Pass 2"), NOT from the implementor's Dockerfile / compose / nginx
# edits (those are being written in parallel): each asserts an INTENDED invariant so
# it can fail on a real defect. Where a value can vary (host ports) it is read from
# .env.example; the admin SPA index marker + the demo-admin identity come from the
# committed sources (web/admin/index.html, tools/keycloak/realm-export.json) — never
# invented.
#
# The admin-plane serving contract under test (spec 08, Pass 2):
#   browser -> http://localhost:${INTERNAL_HTTP_PORT}  (internal-nginx, =8081; the
#     internal front door, host-published this pass)
#       GET /                       -> 200, the ADMIN SPA index   (admin-app image)
#       GET /<deeplink>             -> 200, the ADMIN SPA index    (history fallback)
#       GET /balance/admin/whoami   -> reaches internal-kong (401 w/o token / 200 with
#                                      a valid demo-admin bearer), NEVER a 200 SPA index
#                                      (the `/` catch-all must NOT shadow the admin API)
#       GET /analytics/admin/*      -> reaches internal-kong (still routed, this step)
#       GET /healthz                -> 200 (nginx liveness)
#   admin-app joins edge-internal ONLY and is NOT host-published; internal-kong is NOT
#   host-published; only internal-nginx (:8081) is. The complete DoD port contract —
#   "Only :8080, :8081, :8082 are published" — is realized once :8081 lands (this pass).
#
# The intended PROOF (spec 08 Pass 2 scope note): a demo-admin Keycloak login at :8081
# reaches the REAL /balance/admin/whoami surface through internal-nginx -> internal-kong
# -> balance-service, and the whoami identity is an `admin`. R4 proves that black-box
# with a real demo-admin bearer (the browser-driven variant lives in the admin app's
# login.e2e.ts, which the full-run harness enables).
#
# SCOPE NOTE (serving contract only): the admin app's /accounts + /limits screens call
# balance-service admin READ endpoints (GET /admin/accounts, GET /admin/limits) that NOW
# exist (shipped in PR #50 as role-gated reads) and are exercised end to end by the full-run
# runner (tests/e2e-fullrun/, which drives the admin browser specs against the live stack).
# This build-serve harness stays the SERVING-contract check: the runtime checks target the
# whoami LANDING + SPA serving; a deep-link check asserts the SPA SHELL is served (history
# fallback). It intentionally does NOT drive browser specs or assert accounts/limits DATA.

# ----------------------------------------------------------------------------------
# Environment / globals
# ----------------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$REPO_ROOT/docker-compose.yml"
ENV_EXAMPLE="$REPO_ROOT/.env.example"
INFRA_DIR="$REPO_ROOT/infra"
TOOLS_DIR="$REPO_ROOT/tools"
WEB_DIR="$REPO_ROOT/web"

# Compose service names the spec names explicitly ("`/` -> the `admin-app` image;
# `/balance/admin/` and `/analytics/admin/` -> internal-kong") and the front door.
ADMIN_SVC="admin-app"
NGINX_SVC="internal-nginx"
KONG_SVC="internal-kong"
KEYCLOAK_SVC="keycloak"
BALANCE_UPSTREAM="balance-service"

# Coordination contract (spec 02 / spec 06). Exact names/values the suite asserts.
REALM="supercool"
ALIAS="keycloak.localtest.me"        # shared host alias; must resolve to loopback for PKCE
ADMIN_ROLE="admin"
PREFERRED_CLIENT="admin-app"         # the admin SPA's public client (Authz Code + PKCE, :8081 redirect)

# Admin SPA index discriminator — from the committed web/admin/index.html
# (<title>SuperCool Finances — Admin</title>). vite build preserves the <title>, so
# this survives the production build. Match on the ASCII-safe "Admin</title>" suffix
# (avoids the em-dash): the client index title is exactly "SuperCool Finances" and the
# otp one "SuperCool Finances — OTP" — neither contains "Admin".
ADMIN_TITLE_MARK='Admin</title>'
SPA_ROOT_MARK='id="root"'            # any served SPA index carries the mount node

# The centralized Spotify-green accent token (tailwind.config.js `colors.accent`),
# shared by all three SPAs. A Tailwind-COMPILED bundle embeds it; an index.css shipped
# UNPROCESSED (the build stage that omits postcss.config.js/tailwind.config.js) does not.
THEME_ACCENT='1db954'

# Isolated compose project for the auto/opt-in LIGHT self-up (never touches a real stack).
PROJECT="scfin-build-serve-admin-test"

# Values loaded from .env.example at runtime.
INTERNAL_HTTP_PORT=""
PUBLIC_HTTP_PORT=""
KEYCLOAK_PORT=""

# Discovered artifacts / caches (cleaned on exit).
CONFIG_JSON_FILE=""       # cached resolved-config JSON (temp path)
LAST_CONFIG_ERR=""        # stderr of the last failed `docker compose config`
RUNTIME_ENVFILE=""        # temp copy of .env.example used for `up`; cleaned on exit
DC_FALLBACK_ENV=""
NGINX_CONF=""             # resolved path to the internal-nginx config
REALM_EXPORT=""           # resolved path to the realm export JSON
PKCE_SCRIPT=""            # temp path of the scripted PKCE flow
SELF_UP_DONE=0            # 1 if THIS suite brought the edge up (=> must tear down)

# Minted demo-admin token (empty if minting was skipped/failed -> R4 SKIPs).
ADMIN_TOKEN=""
ADMIN_SUB=""

# curl_probe outputs.
PROBE_CODE=""; PROBE_BODY=""; PROBE_HEADERS=""

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

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

# An error message clearly environmental (offline / registry / daemon) rather than a
# code/spec defect — such failures SKIP, never FAIL.
is_env_failure() {
  printf '%s' "$1" | grep -qiE 'network|timeout|temporary failure|could not resolve|lookup|tls|dial tcp|connection refused|no such host|pull access|manifest unknown|i/o timeout|EAI_AGAIN|registry|cannot connect to the docker daemon'
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
  INTERNAL_HTTP_PORT="$(env_val INTERNAL_HTTP_PORT)"; [ -n "$INTERNAL_HTTP_PORT" ] || INTERNAL_HTTP_PORT="8081"
  PUBLIC_HTTP_PORT="$(env_val PUBLIC_HTTP_PORT)";     [ -n "$PUBLIC_HTTP_PORT" ]   || PUBLIC_HTTP_PORT="8080"
  KEYCLOAK_PORT="$(env_val KEYCLOAK_PORT)";           [ -n "$KEYCLOAK_PORT" ]      || KEYCLOAK_PORT="8082"
}

internal_base()     { printf 'http://localhost:%s' "$INTERNAL_HTTP_PORT"; }
admin_whoami_url()  { printf '%s/balance/admin/whoami' "$(internal_base)"; }
alias_base()        { printf 'http://%s:%s' "$ALIAS" "$KEYCLOAK_PORT"; }

# ----------------------------------------------------------------------------------
# Resolved-config helper — `docker compose config` (docker CLI, NOT the daemon).
#   Returns: 0 ok (CONFIG_JSON_FILE populated), 1 parse failed, 3 docker CLI absent.
# ----------------------------------------------------------------------------------
build_config() {
  if [ -n "$CONFIG_JSON_FILE" ] && [ -f "$CONFIG_JSON_FILE" ]; then return 0; fi
  command -v docker >/dev/null 2>&1 || return 3
  [ -f "$COMPOSE" ] || { LAST_CONFIG_ERR="docker-compose.yml not found at $COMPOSE"; return 1; }
  local tmpenv out err
  tmpenv="$(mktemp)"; out="$(mktemp)"; err="$(mktemp)"
  if [ -f "$ENV_EXAMPLE" ]; then cp "$ENV_EXAMPLE" "$tmpenv"; else : > "$tmpenv"; fi
  if docker compose --project-directory "$REPO_ROOT" --env-file "$tmpenv" \
        -f "$COMPOSE" config --format json >"$out" 2>"$err"; then
    CONFIG_JSON_FILE="$out"; rm -f "$tmpenv" "$err"; return 0
  else
    LAST_CONFIG_ERR="$(cat "$err")"; rm -f "$tmpenv" "$out" "$err"; return 1
  fi
}

# docker compose wrapper for the isolated self-up project (always supplies --env-file
# so internal-nginx's ${INTERNAL_HTTP_PORT} etc. interpolate).
dc() {
  local envf="${RUNTIME_ENVFILE:-}"
  if [ -z "$envf" ] || [ ! -f "$envf" ]; then
    if [ -z "$DC_FALLBACK_ENV" ] || [ ! -f "$DC_FALLBACK_ENV" ]; then
      [ -f "$ENV_EXAMPLE" ] && { DC_FALLBACK_ENV="$(mktemp)"; cp "$ENV_EXAMPLE" "$DC_FALLBACK_ENV"; }
    fi
    envf="$DC_FALLBACK_ENV"
  fi
  if [ -n "$envf" ] && [ -f "$envf" ]; then
    docker compose -p "$PROJECT" --project-directory "$REPO_ROOT" --env-file "$envf" -f "$COMPOSE" "$@"
  else
    docker compose -p "$PROJECT" --project-directory "$REPO_ROOT" -f "$COMPOSE" "$@"
  fi
}

find_nginx_internal_conf() {
  [ -n "$NGINX_CONF" ] && { printf '%s' "$NGINX_CONF"; return 0; }
  local c
  for c in \
    "$INFRA_DIR/nginx-internal/nginx.conf" \
    "$INFRA_DIR/nginx-internal/default.conf" \
    "$INFRA_DIR/nginx_internal/nginx.conf"; do
    [ -f "$c" ] && { NGINX_CONF="$c"; printf '%s' "$c"; return 0; }
  done
  # Fallback: any conf under infra/ that routes the internal admin surface.
  c="$(find "$INFRA_DIR" -type f -iname '*.conf' 2>/dev/null \
        | while IFS= read -r f; do grep -qi 'balance/admin' "$f" 2>/dev/null && { printf '%s\n' "$f"; break; }; done | head -1)"
  [ -n "$c" ] && { NGINX_CONF="$c"; printf '%s' "$c"; return 0; }
  printf ''; return 1
}

find_realm_export() {
  [ -n "$REALM_EXPORT" ] && { printf '%s' "$REALM_EXPORT"; return 0; }
  local c
  for c in \
    "$TOOLS_DIR/keycloak/realm-export.json" \
    "$INFRA_DIR/keycloak/realm-export.json" \
    "$INFRA_DIR/keycloak/import/realm-export.json"; do
    [ -f "$c" ] && { REALM_EXPORT="$c"; printf '%s' "$c"; return 0; }
  done
  c="$(find "$TOOLS_DIR/keycloak" "$INFRA_DIR/keycloak" -type f -iname '*realm*.json' 2>/dev/null | head -1)"
  [ -n "$c" ] && { REALM_EXPORT="$c"; printf '%s' "$c"; return 0; }
  printf ''; return 1
}

# ----------------------------------------------------------------------------------
# HTTP probe — captures status, body and response headers into PROBE_* globals.
#   curl_probe URL [extra curl args...]   (no -L: redirects are asserted, not followed)
# ----------------------------------------------------------------------------------
curl_probe() {
  local url="$1"; shift
  local tmpd; tmpd="$(mktemp -d)"
  PROBE_CODE="$(curl -s --max-time 25 -o "$tmpd/body" -D "$tmpd/hdr" -w '%{http_code}' "$@" "$url" 2>/dev/null)"
  [ -n "$PROBE_CODE" ] || PROBE_CODE="000"
  PROBE_BODY="$(cat "$tmpd/body" 2>/dev/null)"
  PROBE_HEADERS="$(cat "$tmpd/hdr" 2>/dev/null)"
  rm -rf "$tmpd"
}

# --- SPA index discriminators (pure string tests over a response body) ---
is_spa_index()   { case "$1" in *"$SPA_ROOT_MARK"*) return 0 ;; *) return 1 ;; esac; }
is_admin_index() { case "$1" in *"$ADMIN_TITLE_MARK"*) return 0 ;; *) return 1 ;; esac; }

# Does the host resolve the shared alias to loopback? (Needed for the PKCE browser flow.)
host_resolves_alias() {
  [ -n "$PYTHON" ] || return 1
  "$PYTHON" - "$ALIAS" <<'PY'
import socket, sys
try:
    ip = socket.gethostbyname(sys.argv[1])
except Exception:
    sys.exit(1)
sys.exit(0 if ip.startswith("127.") or ip == "0.0.0.0" else 1)
PY
}

# Decode a JWT payload -> KEY<TAB>VALUE lines (sub + realm_roles).
decode_jwt_claims() {  # $1 = access token
  [ -n "$PYTHON" ] || return 3
  "$PYTHON" - "$1" <<'PY'
import sys, json, base64
tok = sys.argv[1]
parts = tok.split('.')
if len(parts) < 2:
    print("ERROR\tnot-a-jwt"); sys.exit(1)
seg = parts[1]; seg += '=' * (-len(seg) % 4)
try:
    payload = json.loads(base64.urlsafe_b64decode(seg.encode()).decode('utf-8'))
except Exception as e:
    print(f"ERROR\tdecode:{e}"); sys.exit(1)
print(f"sub\t{payload.get('sub','')}")
roles = (payload.get('realm_access') or {}).get('roles') or []
print(f"realm_roles\t{' '.join(roles)}")
PY
}

# The scripted Authorization-Code + PKCE (S256) flow (python urllib), identical in
# choreography to the transport/keycloak suites' — proven against a live Keycloak. Auth
# GET -> login POST -> capture 302 `code` -> token exchange WITH the code_verifier.
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
    print("could not locate the Keycloak login form action (unexpected theme / consent / error page)", file=sys.stderr)
    sys.exit(1)
action = html.unescape(m.group(1))

form = urllib.parse.urlencode({"username": username, "password": password, "credentialId": ""}).encode()
FORM_CT = {"Content-Type": "application/x-www-form-urlencoded"}
try:
    resp = nofollow.open(urllib.request.Request(action, data=form, headers=FORM_CT), timeout=30)
    body = resp.read().decode("utf-8", "replace")
    msg = "login POST did not redirect (HTTP %s) => bad credentials or a required action" % resp.getcode()
    mm = re.search(r'id="input-error"[^>]*>([^<]+)<', body) or re.search(r'kc-feedback-text[^>]*>([^<]+)<', body)
    if mm: msg += f": {mm.group(1).strip()}"
    print(msg, file=sys.stderr); sys.exit(1)
except urllib.error.HTTPError as e:
    if e.code not in (301, 302, 303, 307, 308):
        print(f"login POST error HTTP {e.code}: {e.read().decode('utf-8','replace')[:300]}", file=sys.stderr)
        sys.exit(1)
    location = e.headers.get("Location", "")

parsed = urllib.parse.urlparse(location)
params = urllib.parse.parse_qs(parsed.query)
if "code" not in params:
    print(f"no 'code' in redirect Location: {location}", file=sys.stderr); sys.exit(1)
code = params["code"][0]

exch = urllib.parse.urlencode({
    "grant_type": "authorization_code", "code": code,
    "redirect_uri": redirect_uri, "client_id": client_id,
    "code_verifier": verifier,
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

# Mint a REAL demo-admin access token via Authorization-Code + PKCE against the live
# Keycloak. Recovers the seeded user carrying the `admin` realm role (username +
# plaintext demo password) and a public client with a concrete redirect (prefer
# admin-app), straight from realm-export.json — no credential literal is baked in.
# Sets ADMIN_TOKEN + ADMIN_SUB on success. Returns 1 (caller SKIPs) when it cannot mint
# headlessly (no realm export, no python, offline/DNS, or bad creds) — never a false pass.
mint_admin_token() {
  [ -n "$ADMIN_TOKEN" ] && return 0
  local re trip user pass client redirect token
  re="$(find_realm_export)"
  [ -n "$re" ] || { info "no realm export found — cannot recover demo-admin creds for PKCE"; return 1; }
  [ -n "$PYTHON" ] || { info "python not available — cannot run the PKCE flow"; return 1; }
  if ! host_resolves_alias; then
    info "host cannot resolve '$ALIAS' to loopback (offline env) — the PKCE flow needs it (see README manual checkpoint)"
    return 1
  fi
  trip="$("$PYTHON" - "$re" "$ADMIN_ROLE" "$PREFERRED_CLIENT" <<'PY'
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
  if [ -z "$trip" ]; then
    info "no seeded '$ADMIN_ROLE' user with a recoverable plaintext demo password + usable redirect"
    return 1
  fi
  IFS=$'\t' read -r user pass client redirect <<EOF
$trip
EOF
  write_pkce_script
  local errf; errf="$(mktemp)"
  token="$("$PYTHON" "$PKCE_SCRIPT" "$(alias_base)" "$REALM" "$client" "$redirect" "$user" "$pass" 2>"$errf")"
  if [ -z "$token" ]; then
    info "scripted PKCE login for '$user' did not yield a token:"
    sed 's/^/        /' <"$errf" >&2 2>/dev/null
    rm -f "$errf"; return 1
  fi
  rm -f "$errf"
  ADMIN_TOKEN="$token"
  ADMIN_SUB="$(decode_jwt_claims "$token" | awk -F'\t' '$1=="sub"{print $2}')"
  info "minted a real demo-admin token via Authorization-Code + PKCE (client=$client, sub=$ADMIN_SUB)"
  return 0
}

# Assert a whoami body: userId == expected sub AND roles contains the required role.
assert_whoami_body() {  # $1 = expected sub ; $2 = required role ; $3 = body
  "$PYTHON" - "$1" "$2" "$3" <<'PY'
import sys, json
sub, role, body = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.loads(body)
except Exception as e:
    print(f"  -> whoami body is not JSON: {e} | {body[:160]}"); sys.exit(1)
bad = False
uid = d.get("userId")
if uid == sub and sub:
    print(f"  userId == token sub ('{sub}')")
else:
    print(f"  -> userId '{uid}' != token sub '{sub}' — injected identity is wrong"); bad = True
roles = d.get("roles") or []
if isinstance(roles, str): roles = [roles]
if role in roles:
    print(f"  roles contains '{role}' (roles: {roles})")
else:
    print(f"  -> roles does NOT contain '{role}' (got {roles})"); bad = True
sys.exit(1 if bad else 0)
PY
}

# ==================================================================================
# STATIC CHECKS (no live stack; docker CLI + python + file reads)
# ==================================================================================

# Check 1 (static) — `docker compose config` resolves AND the admin-plane trio
# (admin-app, internal-nginx, internal-kong) is wired into the DEFAULT `up` graph
# (no profile gate), so a clean `docker compose up` starts them (spec 08 "Full run").
# A missing/profile-gated admin-app = step-not-done; this FAILs until it is wired.
check_compose_wiring() {
  section "Check 1 (static) — compose config resolves; admin-app + internal-nginx + internal-kong wired into the default up graph"
  [ -f "$COMPOSE" ]     || { fail "docker-compose.yml not found at $COMPOSE"; return; }
  [ -f "$ENV_EXAMPLE" ] || { fail ".env.example not found — needed to resolve config"; return; }
  build_config; local rc=$?
  case $rc in
    3) skip "docker CLI not installed — cannot run 'docker compose config'"; return ;;
    0) : ;;
    *) fail "docker compose config failed to parse:"; printf '%s\n' "$LAST_CONFIG_ERR" >&2; return ;;
  esac
  [ -z "$PYTHON" ] && { skip "python not available to parse resolved config"; return; }
  if "$PYTHON" - "$CONFIG_JSON_FILE" "$ADMIN_SVC" "$NGINX_SVC" "$KONG_SVC" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
services = cfg.get("services") or {}
bad = False
for name in sys.argv[2:]:
    svc = services.get(name)
    if svc is None:
        print(f"  -> service '{name}' NOT defined in the spine (admin plane not wired yet)"); bad = True; continue
    profiles = svc.get("profiles") or []
    if profiles:
        print(f"  -> service '{name}' is gated behind profile(s) {profiles} — it must be in the DEFAULT up graph"); bad = True
    else:
        print(f"  service '{name}' defined (default up graph)")
sys.exit(1 if bad else 0)
PY
  then pass "compose config resolves; $ADMIN_SVC, $NGINX_SVC, $KONG_SVC all in the default up graph"
  else fail "the admin-plane trio is not fully wired into the default up graph"
  fi
}

# Check 2 (static, PORT CONTRACT) — Pass 2 realizes the full DoD contract "Only :8080,
# :8081, :8082 are published": internal-nginx host-publishes :INTERNAL_HTTP_PORT (=8081,
# the internal front door, published THIS pass), the admin SPA image + internal-kong
# host-publish NOTHING, and NO default-graph service publishes a port outside
# {:8080, :8081, :8082}. (spec 08 DoD + "Full run"; scope note Pass 2.)
check_port_contract() {
  section "Check 2 (static) — internal-nginx publishes :$INTERNAL_HTTP_PORT; admin-app+internal-kong publish nothing; no port outside {:$PUBLIC_HTTP_PORT,:$INTERNAL_HTTP_PORT,:$KEYCLOAK_PORT}"
  build_config; local rc=$?
  [ $rc -eq 3 ] && { skip "docker CLI absent — cannot resolve ports"; return; }
  [ $rc -ne 0 ] && { fail "config did not parse — cannot check ports (see Check 1)"; return; }
  [ -z "$PYTHON" ] && { skip "python not available to parse resolved config"; return; }
  if "$PYTHON" - "$CONFIG_JSON_FILE" "$PUBLIC_HTTP_PORT" "$INTERNAL_HTTP_PORT" "$KEYCLOAK_PORT" "$NGINX_SVC" "$ADMIN_SVC" "$KONG_SVC" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
pub, internal, kc, nginx, admin, kong = sys.argv[2:8]
allowed = {pub, internal, kc}
services = cfg.get("services") or {}
bad = False
published = {}   # port -> [services] (default up graph only)

def host_ports(svc):
    out = []
    for p in (svc.get("ports") or []):
        val = p.get("published") if isinstance(p, dict) else None
        out.append("(ephemeral)" if val is None else str(val))
    return out

for name, svc in services.items():
    profiles = svc.get("profiles") or []
    hp = host_ports(svc)
    if profiles:
        if hp: print(f"  NOTE: profile-gated service '{name}' (profiles {profiles}) publishes {hp} — not in the default up graph, ignored")
        continue
    for port in hp:
        published.setdefault(port, []).append(name)

# 1) Nothing published outside the allowed DoD set.
for port, owners in sorted(published.items()):
    if port == "(ephemeral)":
        print(f"  -> {owners} publish an ephemeral/random host port (not allowed)"); bad = True
    elif port not in allowed:
        print(f"  -> host port :{port} is published by {owners} — only :{pub}, :{internal}, :{kc} are allowed (DoD)"); bad = True
    else:
        print(f"  :{port} published by {owners} (allowed)")

# 2) The internal front door IS published this pass, and it is internal-nginx.
if internal not in published:
    print(f"  -> :{internal} (internal-nginx front door) is NOT host-published — Pass 2 must publish it so the admin browser can reach :8081"); bad = True
elif nginx not in published.get(internal, []):
    print(f"  -> :{internal} is published by {published.get(internal)} rather than {nginx}"); bad = True
else:
    print(f"  :{internal} published by {nginx} (the internal front door — required this pass)")

# 3) The admin SPA image + internal-kong must be UNPUBLISHED (reachable only via internal-nginx).
for name in (admin, kong):
    svc = services.get(name)
    if svc is None: continue   # Check 1 already fails on this
    hp = [p for p in host_ports(svc) if p]
    if hp:
        print(f"  -> '{name}' host-publishes {hp} — must be UNPUBLISHED (reachable only via internal-nginx)"); bad = True
sys.exit(1 if bad else 0)
PY
  then pass "port contract holds: :$INTERNAL_HTTP_PORT published by $NGINX_SVC; $ADMIN_SVC + $KONG_SVC unpublished; no port outside the DoD set"
  else fail "port contract violated (a forbidden host port, a missing/mis-owned :$INTERNAL_HTTP_PORT, or a published internal service) — see -> lines"
  fi
}

# Check 3 (static, SPA TOPOLOGY) — the admin SPA image joins edge-internal ONLY (so it
# is reachable solely through the internal-nginx router) and publishes nothing. (spec 08
# "Ports & origin": the SPA images join their edge network only and are not host-published.)
check_spa_topology() {
  section "Check 3 (static) — $ADMIN_SVC on 'edge-internal' only, host-published nothing"
  build_config; local rc=$?
  [ $rc -eq 3 ] && { skip "docker CLI absent — cannot resolve service shape"; return; }
  [ $rc -ne 0 ] && { fail "config did not parse — cannot check topology (see Check 1)"; return; }
  [ -z "$PYTHON" ] && { skip "python not available to parse resolved config"; return; }
  if "$PYTHON" - "$CONFIG_JSON_FILE" "$ADMIN_SVC" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
services = cfg.get("services") or {}
bad = False
name = sys.argv[2]
svc = services.get(name)
if svc is None:
    print(f"  -> '{name}' not defined"); bad = True
else:
    nets = set((svc.get("networks") or {}).keys())
    if nets == {"edge-internal"}:
        print(f"  {name} on exactly 'edge-internal'")
    else:
        print(f"  -> {name} networks are {sorted(nets)} — must be exactly ['edge-internal'] (router-only reachability)"); bad = True
    if svc.get("ports"):
        print(f"  -> {name} host-publishes ports {svc.get('ports')} — must be unpublished"); bad = True
sys.exit(1 if bad else 0)
PY
  then pass "$ADMIN_SVC is on edge-internal only and host-publishes nothing"
  else fail "admin SPA topology violates the macro (wrong network membership or a published port)"
  fi
}

# Check 4 (static, NGINX ROUTER) — the internal-nginx config, once wired for spec 08:
# (a) STILL routes /balance/admin/ -> internal-kong (admin API preserved);
# (b) STILL routes /analytics/admin/ -> internal-kong (analytics admin preserved);
# (c) serves the ADMIN SPA at / — the spec-06 gateway-only `return 404` placeholder is
#     GONE and `/` now targets the admin-app image; and
# (d) keeps the /healthz liveness endpoint.
# Robust, low-false-positive textual parse: FAILs only on clearly-detectable regressions;
# the definitive serving/routing proof is the runtime suite (R1-R4).
check_nginx_router() {
  section "Check 4 (static) — internal-nginx routes /balance/admin + /analytics/admin -> kong, serves admin SPA at / (no 404 placeholder), keeps /healthz"
  local conf; conf="$(find_nginx_internal_conf)"
  [ -z "$conf" ] && { fail "no internal-nginx config found under infra/ — cannot verify the router"; return; }
  info "internal-nginx config: ${conf#$REPO_ROOT/}"
  [ -z "$PYTHON" ] && { skip "python not available to parse the nginx config"; return; }
  "$PYTHON" - "$conf" "$KONG_SVC" "$ADMIN_SVC" <<'PY'
import sys, re
conf, kong, admin = sys.argv[1], sys.argv[2], sys.argv[3]
raw = open(conf, encoding='utf-8').read()

# Extract brace-balanced `location <matcher> { ... }` blocks.
blocks = []   # (matcher, body)
for m in re.finditer(r'location\s+([^\{]+?)\s*\{', raw):
    matcher = m.group(1).strip()
    depth = 1; j = m.end()
    while j < len(raw) and depth > 0:
        if raw[j] == '{': depth += 1
        elif raw[j] == '}': depth -= 1
        j += 1
    blocks.append((matcher, raw[m.end():j-1]))

def block_for(pred):
    for matcher, body in blocks:
        if pred(matcher): return matcher, body
    return None, None

# The internal-nginx admin routes proxy to internal-kong through a variable upstream
# (`set $kong_upstream internal-kong; proxy_pass http://$kong_upstream:8000...`), so the
# kong target is the literal service name appearing anywhere in the block (a substring
# test is robust to the variable-upstream pattern).
def routes_to(body, target):
    return target in body

problems = []

# (a) /balance/admin/ still routed to internal-kong (admin API preserved, not shadowed).
_, bal_body = block_for(lambda mt: 'balance/admin' in mt)
if bal_body is None:
    problems.append("no `location .../balance/admin` block — the admin API route was removed/shadowed")
elif not routes_to(bal_body, kong):
    problems.append(f"the /balance/admin block no longer targets `{kong}` (admin API not reaching the internal gateway)")
else:
    print(f"  OK  /balance/admin -> {kong} preserved")

# (b) /analytics/admin/ still routed to internal-kong.
_, an_body = block_for(lambda mt: 'analytics/admin' in mt)
if an_body is None:
    problems.append("no `location .../analytics/admin` block — the analytics admin route was removed")
elif not routes_to(an_body, kong):
    problems.append(f"the /analytics/admin block no longer targets `{kong}`")
else:
    print(f"  OK  /analytics/admin -> {kong} preserved")

# (c) the root `location /` is no longer the spec-06 gateway-only placeholder, and now
#     serves the admin SPA (targets admin-app, or serves a bundle locally).
root_matcher, root_body = block_for(lambda mt: mt.strip() in ('/', '/ '))
if root_body is None:
    problems.append("no root `location /` block — the admin SPA is not served at /")
elif re.search(r'\breturn\s+404\b', root_body):
    problems.append("root `location /` still `return 404` (spec-06 gateway-only placeholder) — admin SPA not wired at /")
else:
    served = routes_to(root_body, admin) or ('proxy_pass' in root_body) or ('try_files' in root_body) or re.search(r'\broot\s', root_body)
    if routes_to(root_body, admin):
        print(f"  OK  root `location /` serves the admin SPA (targets {admin}; no 404 placeholder)")
    elif served:
        print("  OK  root `location /` serves a SPA bundle (no 404 placeholder) — runtime R1 confirms it is the admin index")
    else:
        problems.append(f"root `location /` neither targets {admin} nor serves a bundle (root/try_files/proxy_pass)")

# (d) /healthz liveness preserved.
_, hz_body = block_for(lambda mt: 'healthz' in mt)
if hz_body is None or not re.search(r'\b200\b', hz_body):
    problems.append("no `location = /healthz` returning 200 — nginx liveness endpoint missing")
else:
    print("  OK  /healthz -> 200 liveness preserved")

for p in problems: print(f"  -> {p}")
sys.exit(1 if problems else 0)
PY
  local prc=$?
  case $prc in
    0) pass "internal-nginx router: /balance/admin + /analytics/admin -> $KONG_SVC preserved, admin SPA at / (no 404 placeholder), /healthz 200" ;;
    *) fail "internal-nginx router config regressed (see -> lines) — an admin API route shadowed/dropped, the 404 placeholder left in, or /healthz dropped" ;;
  esac
}

# ==================================================================================
# RUNTIME CHECKS (need the internal edge reachable at :INTERNAL_HTTP_PORT)
# ==================================================================================

edge_reachable() {
  local code
  code="$(curl -s --max-time 6 -o /dev/null -w '%{http_code}' "$(internal_base)/healthz" 2>/dev/null)"
  [ -n "$code" ] && [ "$code" != "000" ]
}

# Is the admin plane actually defined? (Gate the self-up: don't `up` services that do not
# exist yet — Check 1 already reports "not wired".) We self-up only internal-nginx + admin-app.
admin_plane_defined() {
  build_config || return 1
  [ -z "$PYTHON" ] && return 1
  "$PYTHON" - "$CONFIG_JSON_FILE" "$NGINX_SVC" "$ADMIN_SVC" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
services = cfg.get("services") or {}
sys.exit(0 if all(n in services for n in sys.argv[2:]) else 1)
PY
}

# Bring up JUST the admin-plane serving pieces in the isolated project, LIGHT: with
# --no-deps so we don't drag up the whole backend chain (kong/keycloak/postgres/balance).
# The catch-all-not-shadowed proof (R3) still holds — /balance/admin yields a 502
# (internal-kong absent), NOT a 200 SPA index. The whoami vertical slice (R4) needs the
# full internal chain and SKIPs under this light bring-up.
# Sets SELF_UP_DONE=1 on success so the phase runner tears it down afterward.
#   Returns: 0 up, 1 environmental failure (pull/build/offline -> SKIP),
#            2 real up/build defect (-> FAIL), 3 name conflict (-> SKIP).
self_up() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  # Never fight a live stack that shares the spine's pinned container_names.
  local n cid proj conflict=""
  for n in postgres redis mongo; do
    cid="$(docker ps -aq --filter "name=^${n}$" 2>/dev/null | head -1)"
    if [ -n "$cid" ]; then
      proj="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$cid" 2>/dev/null)"
      [ "$proj" = "$PROJECT" ] || conflict="$conflict ${n}(project='${proj:-none}')"
    fi
  done
  [ -n "$conflict" ] && { info "self-up skipped — container name(s) already in use:$conflict"; return 3; }

  RUNTIME_ENVFILE="$(mktemp)"; cp "$ENV_EXAMPLE" "$RUNTIME_ENVFILE"
  dc down -v --remove-orphans >/dev/null 2>&1
  info "self-up: building + starting $NGINX_SVC, $ADMIN_SVC (--no-deps) under project '$PROJECT' (this can take a few minutes)…"
  local err rc; err="$(mktemp)"
  dc up -d --build --no-deps --wait "$NGINX_SVC" "$ADMIN_SVC" >/dev/null 2>"$err"; rc=$?
  if [ "$rc" -ne 0 ]; then
    local msg; msg="$(cat "$err")"; rm -f "$err"
    if is_env_failure "$msg"; then
      info "self-up failed for an ENVIRONMENTAL reason (offline / registry). First lines:"; printf '%s\n' "$msg" | head -8 >&2
      dc down -v --remove-orphans >/dev/null 2>&1
      return 1
    fi
    info "self-up (docker compose up --build) failed — this is a real spec-08 build/serve defect. First lines:"; printf '%s\n' "$msg" | head -20 >&2
    dc down -v --remove-orphans >/dev/null 2>&1
    return 2
  fi
  rm -f "$err"; SELF_UP_DONE=1; return 0
}

self_down() {
  [ "$SELF_UP_DONE" -eq 1 ] || return 0
  info "self-up teardown: 'docker compose down -v' for project '$PROJECT'"
  dc down -v --remove-orphans >/dev/null 2>&1
  SELF_UP_DONE=0
}

# --- R5 — nginx liveness. GET /healthz -> 200 'ok'. ---
check_healthz() {
  section "R5 (runtime) — GET /healthz -> 200 (internal-nginx liveness)"
  curl_probe "$(internal_base)/healthz"
  if [ "$PROBE_CODE" = "200" ]; then
    pass "GET /healthz -> 200 (the internal front door is live)"
  else
    fail "GET /healthz -> HTTP $PROBE_CODE (expected 200) — the internal front door is not serving its liveness endpoint"
  fi
}

# --- R1 — GET / -> 200 admin SPA index. ---
check_admin_root() {
  section "R1 (runtime) — GET / -> 200 serving the ADMIN SPA index"
  curl_probe "$(internal_base)/"
  if [ "$PROBE_CODE" != "200" ]; then
    fail "GET / -> HTTP $PROBE_CODE (expected 200) — the admin SPA is not served at the root (the / catch-all is still the 404 placeholder or admin-app is down)"; return
  fi
  if is_admin_index "$PROBE_BODY"; then
    pass "GET / -> 200 with the admin SPA index (title contains 'Admin', $SPA_ROOT_MARK)"
  elif is_spa_index "$PROBE_BODY"; then
    fail "GET / -> 200 with a SPA index but NOT the admin one (no 'Admin' <title>) — the root is misrouted to the wrong bundle. Body head: $(printf '%s' "$PROBE_BODY" | head -c 200)"
  else
    fail "GET / -> 200 but the body is not a SPA index (no $SPA_ROOT_MARK / admin <title>). Body head: $(printf '%s' "$PROBE_BODY" | head -c 200)"
  fi
}

# --- R2 — admin deep link -> 200 admin index (history fallback / SPA shell only). ---
# This proves the admin-app owns its `try_files … /index.html` history fallback, so a
# deep link survives a reload. It asserts ONLY that the SPA SHELL is served — NOT that the
# /accounts screen's data loads (its GET /admin/accounts endpoint does not exist yet).
check_admin_deeplink() {
  section "R2 (runtime) — GET /accounts (deep link) -> 200 admin index (SPA history fallback; shell only)"
  curl_probe "$(internal_base)/accounts"
  if [ "$PROBE_CODE" != "200" ]; then
    fail "GET /accounts -> HTTP $PROBE_CODE (expected 200) — the admin SPA history fallback (try_files -> /index.html) is missing; a deep link 404s on reload"; return
  fi
  if is_admin_index "$PROBE_BODY"; then
    pass "GET /accounts -> 200 admin index (history fallback serves the admin SPA shell)"
  else
    fail "GET /accounts -> 200 but not the admin index (fallback served the wrong content). Body head: $(printf '%s' "$PROBE_BODY" | head -c 200)"
  fi
}

# --- R3 (highest-value routing invariant) — the `/` catch-all does NOT shadow the admin
# API. GET /balance/admin/whoami with NO token must NOT be a 200 SPA index page. With the
# full internal edge it is a 401 from Kong; with a light self-up (kong absent) it is a
# 502 — either way NOT the admin index HTML. ---
check_api_not_shadowed() {
  section "R3 (runtime) — the / catch-all does NOT shadow the admin API: no-token GET /balance/admin/whoami is not a 200 SPA page"
  curl_probe "$(admin_whoami_url)"
  local bad=0
  if is_spa_index "$PROBE_BODY"; then
    fail "GET /balance/admin/whoami returned SPA index HTML (HTTP $PROBE_CODE, $SPA_ROOT_MARK present) — the / catch-all SHADOWS the admin API (gateway requests answered by the admin SPA!)"; bad=1
  fi
  if [ "$bad" -eq 0 ]; then
    if [ "$PROBE_CODE" = "401" ]; then
      info "no-token GET /balance/admin/whoami -> 401 (rejected at internal-kong; full internal edge up) — the admin API reaches the gateway, not the SPA"
    elif [ "$PROBE_CODE" = "000" ]; then
      fail "GET /balance/admin/whoami -> no response (000) — the /balance/admin location is not reachable at all"; bad=1
    else
      info "no-token GET /balance/admin/whoami -> HTTP $PROBE_CODE (not a SPA page) — /balance/admin is proxied to the gateway (401 needs internal-kong; it may be absent in a light bring-up)"
    fi
  fi
  [ "$bad" -eq 0 ] && pass "the /balance/admin route is not shadowed by the / catch-all (response is not a SPA index page)"
}

# --- R4 (the spec-08 Pass-2 PROOF) — a REAL demo-admin bearer -> GET /balance/admin/whoami
# on the internal edge -> 200 with { userId == token sub, roles contains 'admin' }. Proves
# the full internal chain: internal-nginx -> internal-kong (JWT verified, admin gate,
# X-User-Id/X-Roles injected, /balance stripped) -> balance-service /admin/whoami. Needs
# internal-kong + balance-service + keycloak all up (an already-running full stack); it
# SKIPs under a light self-up and when a token cannot be minted headlessly. ---
check_admin_whoami_slice() {
  section "R4 (runtime) — demo-admin bearer -> GET /balance/admin/whoami -> 200, userId==sub, roles has '$ADMIN_ROLE'"
  if ! command -v curl >/dev/null 2>&1; then skip "curl not installed"; return; fi
  if ! mint_admin_token; then
    skip "no demo-admin token available (Keycloak not reachable / offline / DNS) — the whoami vertical slice needs one; bring the FULL stack up (docker compose up) and re-run"
    return
  fi
  [ -z "$PYTHON" ] && { skip "python not available to assert the JSON body"; return; }
  curl_probe "$(admin_whoami_url)" -H "Authorization: Bearer $ADMIN_TOKEN"
  case "$PROBE_CODE" in
    200)
      if is_spa_index "$PROBE_BODY"; then
        fail "GET /balance/admin/whoami (admin bearer) -> 200 but the body is the admin SPA index — the API is shadowed by the catch-all, not answered by balance-service"; return
      fi
      if assert_whoami_body "$ADMIN_SUB" "$ADMIN_ROLE" "$PROBE_BODY"; then
        pass "vertical slice GREEN: demo-admin bearer -> /balance/admin/whoami 200 with userId==sub and roles including '$ADMIN_ROLE' (reached balance-service through internal-nginx -> internal-kong)"
      else
        fail "whoami 200 but the echoed identity is wrong (internal-kong injected the wrong X-User-Id/X-Roles, or the wrong upstream answered)"
      fi
      ;;
    401|403)
      fail "GET /balance/admin/whoami with a VALID demo-admin bearer -> HTTP $PROBE_CODE — the internal edge rejected an admin (JWKS/iss/aud/role gate misconfigured; the demo-admin login cannot reach the admin surface). Body: $(printf '%s' "$PROBE_BODY" | head -c 160)"
      ;;
    502|503|504|000)
      skip "GET /balance/admin/whoami -> HTTP $PROBE_CODE — the internal gateway/upstream is not reachable (internal-kong or balance-service not up; a light bring-up). Bring the FULL stack up to prove the whoami vertical slice"
      ;;
    *)
      fail "GET /balance/admin/whoami (admin bearer) -> HTTP $PROBE_CODE (expected 200) — the admin token did not reach balance-service. Body: $(printf '%s' "$PROBE_BODY" | head -c 160)"
      ;;
  esac
}

# --- R6 — the served ADMIN stylesheet is TAILWIND-COMPILED (styling regression guard).
# The build defect: the admin-app Dockerfile build stage omitted postcss.config.js /
# tailwind.config.js, so Vite ran no PostCSS pass and shipped index.css with its @tailwind
# directives + @apply rules intact — invalid CSS the browser drops, so the admin app
# renders completely unstyled (while `npm run dev` and the css:false vitest suites look
# fine — masking it). Fetch the admin index, find the stylesheet it links, fetch that, and
# assert PostCSS ran (no literal `@tailwind`) AND the theme compiled in (the palette accent
# is present). Runs against the light self-up too (admin-app serves its own CSS). ---
check_admin_css_compiled() {
  section "R6 (runtime) — the served ADMIN stylesheet is Tailwind-compiled (theme present, no raw @tailwind)"
  curl_probe "$(internal_base)/"
  if [ "$PROBE_CODE" != "200" ]; then
    skip "admin CSS: cannot read the SPA index (GET / -> $PROBE_CODE) — see R1; styling not verifiable here"; return
  fi
  local href
  href="$(printf '%s' "$PROBE_BODY" | grep -oiE 'href="[^"]+\.css"' | head -1 | sed -E 's/^href="//; s/"$//')"
  if [ -z "$href" ]; then
    fail "admin CSS: the served index links NO stylesheet (<link ... .css>) — the app ships no CSS at all. Body head: $(printf '%s' "$PROBE_BODY" | head -c 200)"; return
  fi
  local css_url
  case "$href" in
    http://*|https://*) css_url="$href" ;;
    /*)                 css_url="$(internal_base)$href" ;;
    *)                  css_url="$(internal_base)/$href" ;;
  esac
  info "admin stylesheet: $href"
  curl_probe "$css_url"
  if [ "$PROBE_CODE" != "200" ]; then
    fail "admin CSS: GET $href -> HTTP $PROBE_CODE (expected 200) — the stylesheet the index links does not load"; return
  fi
  if printf '%s' "$PROBE_BODY" | grep -q '@tailwind'; then
    fail "admin CSS: the served stylesheet still contains a literal '@tailwind' directive — Tailwind/PostCSS did NOT run at build time (the Dockerfile build stage is missing postcss.config.js / tailwind.config.js). The admin app renders unstyled."; return
  fi
  if printf '%s' "$PROBE_BODY" | grep -qi "$THEME_ACCENT"; then
    pass "admin CSS: Tailwind-compiled — no literal @tailwind and the theme accent #$THEME_ACCENT is present ($(printf '%s' "$PROBE_BODY" | wc -c | tr -d ' ') bytes)"
  else
    fail "admin CSS: the theme accent #$THEME_ACCENT is absent from the served stylesheet — the Tailwind theme (tailwind.config.js) was not compiled in (config not copied into the build stage, or content globs purged everything)."
  fi
}

# ----------------------------------------------------------------------------------
# Phase runners
# ----------------------------------------------------------------------------------
run_static() {
  section "STATIC CHECKS (no live stack; docker CLI + python + file reads)"
  load_env_values
  check_compose_wiring
  check_port_contract
  check_spa_topology
  check_nginx_router
}

run_runtime() {
  load_env_values
  section "RUNTIME CHECKS (internal edge reachable at :$INTERNAL_HTTP_PORT)"
  if ! command -v curl >/dev/null 2>&1; then
    skip "curl not installed — runtime checks need it to drive the edge"; return
  fi

  if edge_reachable; then
    info "internal edge already reachable at $(internal_base) — running black-box checks against the live stack (R4 vertical slice runs if the full internal chain is up)"
  else
    if [ "${BUILD_SERVE_NO_SELFUP:-0}" = "1" ]; then
      skip "internal edge not reachable at $(internal_base) and BUILD_SERVE_NO_SELFUP=1 — bring the stack up first ('docker compose up -d --build'); runtime checks skipped (never a false pass)"
      return
    fi
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
      skip "internal edge not reachable and no Docker daemon to self-up — bring the stack up first; runtime checks skipped"
      return
    fi
    if ! admin_plane_defined; then
      skip "internal edge not reachable and the admin-plane services are not wired yet (see Check 1) — cannot self-up; runtime checks skipped"
      return
    fi
    self_up; local rc=$?
    case $rc in
      0) : ;;
      2) fail "self-up: 'docker compose up --build' failed on a real defect (see above) — the admin plane does not build/serve"; return ;;
      3) skip "self-up skipped (a conflicting stack is already running under other names) — 'docker compose down' then re-run"; return ;;
      *) skip "self-up could not bring the edge up in this environment (offline/registry) — bring the stack up manually then re-run"; return ;;
    esac
    if ! edge_reachable; then
      fail "self-up reported ready but the edge is still not reachable at $(internal_base) — internal-nginx did not come up healthy"
      return
    fi
    info "internal edge reachable at $(internal_base) (brought up LIGHT by this suite — internal-kong/balance/keycloak absent, so the R4 whoami slice will SKIP)"
  fi

  check_healthz
  check_admin_root
  check_admin_deeplink
  check_api_not_shadowed
  check_admin_whoami_slice
  check_admin_css_compiled
}

# Idempotent cleanup of anything this suite creates; safe on any exit.
global_cleanup() {
  self_down
  [ -n "${CONFIG_JSON_FILE:-}" ] && rm -f "$CONFIG_JSON_FILE" 2>/dev/null
  [ -n "${RUNTIME_ENVFILE:-}" ]  && rm -f "$RUNTIME_ENVFILE" 2>/dev/null
  [ -n "${DC_FALLBACK_ENV:-}" ]  && rm -f "$DC_FALLBACK_ENV" 2>/dev/null
  [ -n "${PKCE_SCRIPT:-}" ]      && rm -f "$PKCE_SCRIPT" 2>/dev/null
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
