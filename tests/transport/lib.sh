#!/usr/bin/env bash
# lib.sh — shared helpers and all verification checks for the PUBLIC EDGE of
# TRANSPORT (Spec 06, Step 1). Sourced by run.sh; defines functions only, never exits.
#
# Checks are written FROM the spec (specs/06-transport.md — "Definition of Done" and
# "The vertical-slice checkpoint") and the Step-1 coordination contract, NOT from the
# implementor's nginx/kong config: they assert the INTENDED invariants so they can fail
# on a real defect. Where a value can vary (host ports) it is read from .env.example;
# realm/user/client facts come from tools/keycloak/realm-export.json — never hardcoded.
#
# The wire contract under test (Step-1 coordination):
#   public entrypoint  http://localhost:${PUBLIC_HTTP_PORT}   (public-nginx, =8080)
#     -> proxies /balance/* -> public-kong (route /balance/api, STRIPS /balance)
#     -> balance-service:3000 (serves its built /api/*)
#   vertical slice     GET /balance/api/whoami -> 200 JSON { userId, roles } echoing the
#                      Kong-injected identity (X-User-Id = token sub; X-Roles = roles).
#   Kong enforces      valid signature (JWKS) + exp + iss + aud=supercool-api + realm
#                      role `customer`; and STRIPS any client-supplied X-User-Id/X-Roles
#                      before the upstream (anti-spoof).
#
# SCOPE: PUBLIC plane only. /admin, the internal edge, and analytics are Step 2.
#
# TOKEN MINTING: all three SPA clients have directAccessGrantsEnabled=false (a deliberate
# security posture — do NOT weaken it), so no password/direct grant is available. Real
# customer tokens come ONLY via the Authorization-Code + PKCE (S256) flow. We mint one
# headlessly with the SAME proven scripted flow the keycloak suite uses (write_pkce_script);
# if the host cannot resolve the shared alias to loopback (fully offline), the token-
# dependent runtime checks SKIP with a message and point at the manual checkpoint in
# README.md — never a false pass.

# ----------------------------------------------------------------------------------
# Environment / globals
# ----------------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$REPO_ROOT/docker-compose.yml"
ENV_EXAMPLE="$REPO_ROOT/.env.example"
INFRA_DIR="$REPO_ROOT/infra"
TOOLS_DIR="$REPO_ROOT/tools"

# Coordination contract (spec 06 / spec 02). Exact names/values the suite asserts.
REALM="supercool"
ALIAS="keycloak.localtest.me"
AUD="supercool-api"
CUSTOMER_ROLE="customer"
ADMIN_ROLE="admin"
PREFERRED_CLIENT="client-app"     # the public customer SPA (Authorization Code + PKCE)
BALANCE_UPSTREAM="balance-service" # compose service name the /api route targets

# Values loaded from .env.example at runtime.
PUBLIC_HTTP_PORT=""
KEYCLOAK_PORT=""
ISSUER=""

# Discovered artifacts / caches (cleaned on exit).
CONFIG_JSON_FILE=""     # cached resolved-config JSON (temp path)
LAST_CONFIG_ERR=""      # stderr of the last failed `docker compose config`
PKCE_SCRIPT=""          # temp path of the PKCE flow script
KONG_PUBLIC_CFG=""      # resolved path to the public-kong declarative config
REALM_EXPORT=""         # resolved path to the realm export JSON

# Runtime state.
CUSTOMER_TOKEN=""       # minted demo-customer access token (empty if minting skipped/failed)
CUSTOMER_SUB=""         # its `sub` claim
UPSTREAM_MARKER=""      # header name proven to mark a genuinely-proxied response ("" if none)

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
  ISSUER="http://${ALIAS}:${KEYCLOAK_PORT}/realms/${REALM}"
}

# ----------------------------------------------------------------------------------
# Discovery helpers
# ----------------------------------------------------------------------------------
find_realm_export() {
  [ -n "$REALM_EXPORT" ] && { printf '%s' "$REALM_EXPORT"; return 0; }
  local c
  for c in \
    "$TOOLS_DIR/keycloak/realm-export.json" \
    "$INFRA_DIR/keycloak/realm-export.json" \
    "$INFRA_DIR/keycloak/import/realm-export.json"; do
    if [ -f "$c" ]; then REALM_EXPORT="$c"; printf '%s' "$c"; return 0; fi
  done
  local f
  f="$(find "$TOOLS_DIR/keycloak" "$INFRA_DIR/keycloak" -type f -iname '*realm*.json' 2>/dev/null | head -1)"
  if [ -n "$f" ]; then REALM_EXPORT="$f"; printf '%s' "$f"; return 0; fi
  printf ''; return 1
}

# Locate the PUBLIC-kong declarative config. Prefer infra/kong-public/*, then any
# Kong declarative file under infra/ that routes `/api` (the public surface) — never
# the internal one (which routes /admin). Prints the path or nothing.
find_kong_public_config() {
  [ -n "$KONG_PUBLIC_CFG" ] && { printf '%s' "$KONG_PUBLIC_CFG"; return 0; }
  local d f
  for d in "$INFRA_DIR/kong-public" "$INFRA_DIR/kong_public" "$INFRA_DIR/public-kong"; do
    [ -d "$d" ] || continue
    f="$(find "$d" -maxdepth 2 -type f \( -iname '*.yml' -o -iname '*.yaml' -o -iname '*.json' \) 2>/dev/null \
          | while IFS= read -r c; do grep -qi '_format_version\|services:\|routes:' "$c" 2>/dev/null && { printf '%s\n' "$c"; break; }; done | head -1)"
    if [ -n "$f" ]; then KONG_PUBLIC_CFG="$f"; printf '%s' "$f"; return 0; fi
  done
  # Fallback: any Kong declarative file under infra that mentions `/api` but not `/admin`.
  [ -d "$INFRA_DIR" ] || { printf ''; return 1; }
  f="$(find "$INFRA_DIR" -type f \( -iname '*.yml' -o -iname '*.yaml' \) 2>/dev/null \
        | while IFS= read -r c; do
            if grep -qi '_format_version' "$c" 2>/dev/null && grep -q '/api' "$c" 2>/dev/null && ! grep -q '/admin' "$c" 2>/dev/null; then
              printf '%s\n' "$c"; break
            fi
          done | head -1)"
  if [ -n "$f" ]; then KONG_PUBLIC_CFG="$f"; printf '%s' "$f"; return 0; fi
  printf ''; return 1
}

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

# ----------------------------------------------------------------------------------
# HTTP probe — captures status, body, and response headers into PROBE_* globals.
#   curl_probe URL [extra curl args...]
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

edge_base()  { printf 'http://localhost:%s' "$PUBLIC_HTTP_PORT"; }
# External public path is namespaced: /balance/api/* ; Kong strips /balance so the
# balance service still serves its built /api/whoami (developer routing ruling).
whoami_url() { printf '%s/balance/api/whoami' "$(edge_base)"; }
alias_base() { printf 'http://%s:%s' "$ALIAS" "$KEYCLOAK_PORT"; }

# Did a response come FROM the balance service (i.e. reach the upstream)? Balance
# responses are unambiguous: success carries userId/roles; every error carries the
# {error:{code,message,requestId}} envelope (the AllExceptionsFilter shape). Kong's
# own short-circuit bodies ({"message":...}) carry none of these. The self-calibrated
# Kong upstream-latency header (see UPSTREAM_MARKER) is used as a second signal.
reached_balance() {   # $1 = body ; $2 = headers
  case "$1" in
    *'"requestId"'*|*'"userId"'*|*'"roles"'*) return 0 ;;
  esac
  if [ -n "$UPSTREAM_MARKER" ] && printf '%s' "$2" | grep -qi "^${UPSTREAM_MARKER}:"; then
    return 0
  fi
  return 1
}

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

# Decode a JWT payload -> KEY<TAB>VALUE lines: sub, iss, aud (space-joined), realm_roles.
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
def out(k, v): print(f"{k}\t{v}")
out("sub", payload.get("sub", ""))
out("iss", payload.get("iss", ""))
aud = payload.get("aud", "")
if isinstance(aud, list): aud = " ".join(aud)
out("aud", aud)
roles = (payload.get("realm_access") or {}).get("roles") or []
out("realm_roles", " ".join(roles))
PY
}

# ----------------------------------------------------------------------------------
# Token minting — a REAL Authorization-Code + PKCE (S256) login for a seeded user
# carrying a given realm role. Reuses the proven scripted flow from the keycloak suite
# (no client is weakened). Prints the access token on stdout (diagnostics -> stderr);
# empty output means it could not mint headlessly (caller SKIPs, never a false pass).
# ----------------------------------------------------------------------------------
pkce_token_for_role() {   # $1 = realm role to mint a token for
  local role="$1" re trip user pass client redirect token
  re="$(find_realm_export)"
  [ -n "$re" ] || { printf 'no realm export found — cannot recover %s creds for PKCE\n' "$role" >&2; return 1; }
  [ -n "$PYTHON" ] || { printf 'python not available — cannot run the PKCE flow\n' >&2; return 1; }
  if ! host_resolves_alias; then
    printf "host cannot resolve '%s' to loopback (offline env) — the PKCE flow needs it (see README manual checkpoint)\n" "$ALIAS" >&2
    return 1
  fi
  # Recover a user with this role (username + plaintext demo password) and a public
  # client with a concrete redirect. Prefer client-app; fall back to any standard-flow
  # client. The 302 `code` is captured directly, so the redirect never has to resolve.
  trip="$("$PYTHON" - "$re" "$role" "$PREFERRED_CLIENT" <<'PY'
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
    printf "no seeded '%s' user with a recoverable plaintext demo password + usable redirect\n" "$role" >&2
    return 1
  fi
  IFS=$'\t' read -r user pass client redirect <<EOF
$trip
EOF
  write_pkce_script
  token="$("$PYTHON" "$PKCE_SCRIPT" "$(alias_base)" "$REALM" "$client" "$redirect" "$user" "$pass" 2>/tmp/scfin_transport_pkce_err)"
  if [ -z "$token" ]; then
    printf "scripted PKCE login for '%s' did not yield a token:\n" "$user" >&2
    sed 's/^/        /' </tmp/scfin_transport_pkce_err >&2 2>/dev/null
    rm -f /tmp/scfin_transport_pkce_err
    return 1
  fi
  rm -f /tmp/scfin_transport_pkce_err
  printf '%s' "$token"
}

# Mint + cache the demo-customer token (sets CUSTOMER_TOKEN + CUSTOMER_SUB).
mint_customer_token() {
  [ -n "$CUSTOMER_TOKEN" ] && return 0
  local token; token="$(pkce_token_for_role "$CUSTOMER_ROLE")"
  [ -n "$token" ] || return 1
  CUSTOMER_TOKEN="$token"
  CUSTOMER_SUB="$(decode_jwt_claims "$token" | awk -F'\t' '$1=="sub"{print $2}')"
  info "minted a real demo-customer token via Authorization-Code + PKCE (sub=$CUSTOMER_SUB)"
  return 0
}

# The scripted Authorization-Code + PKCE (S256) flow (python urllib), identical in
# choreography to the keycloak suite's — proven against a live Keycloak. Auth GET ->
# login POST -> capture 302 `code` -> token exchange WITH the code_verifier.
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

# ==================================================================================
# STATIC CHECKS (no live stack; docker CLI + python only)
# ==================================================================================

# Check 1 (static) — `docker compose config` resolves with .env.example values, AND the
# public-edge trio (public-nginx, public-kong, balance-service) is defined in the spine.
# (Task item 7: "docker compose config is valid".) A missing public service = step-not-done.
check_compose_config() {
  section "Check 1 (static) — docker compose config resolves; public-edge trio defined"
  if [ ! -f "$COMPOSE" ]; then fail "docker-compose.yml not found at $COMPOSE"; return; fi
  if [ ! -f "$ENV_EXAMPLE" ]; then fail ".env.example not found — needed to resolve config"; return; fi
  build_config; local rc=$?
  case $rc in
    3) skip "docker CLI not installed — cannot run 'docker compose config'"; return ;;
    0) : ;;
    *) fail "docker compose config failed to parse:"; printf '%s\n' "$LAST_CONFIG_ERR" >&2; return ;;
  esac
  [ -z "$PYTHON" ] && { skip "python not available to parse resolved config"; return; }
  if "$PYTHON" - "$CONFIG_JSON_FILE" "$BALANCE_UPSTREAM" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
balance = sys.argv[2]
services = cfg.get("services") or {}
bad = False
for name in ("public-nginx", "public-kong", balance):
    if name in services:
        print(f"  service '{name}' defined")
    else:
        print(f"  -> service '{name}' NOT defined in the spine (public edge not wired yet)"); bad = True
sys.exit(1 if bad else 0)
PY
  then pass "compose config resolves; public-nginx, public-kong, $BALANCE_UPSTREAM all defined"
  else fail "compose config resolved but the public-edge trio is not fully wired into the spine"
  fi
}

# Check 2 (static) — PUBLIC-edge isolation shape (spec 00 §2/§3; spec 06 moving parts):
#   * public-nginx host-publishes ${PUBLIC_HTTP_PORT} (the only public host port) and is
#     on edge-public;
#   * public-kong and balance-service host-publish NOTHING (unpublished internal services)
#     — the gateway and the app must never be reachable except through the nginx edge.
check_public_edge_topology() {
  section "Check 2 (static) — only public-nginx host-publishes :$PUBLIC_HTTP_PORT; kong+balance unpublished (spec 00 §3)"
  build_config; local rc=$?
  [ $rc -eq 3 ] && { skip "docker CLI absent — cannot resolve service shape"; return; }
  [ $rc -ne 0 ] && { fail "config did not parse — cannot check topology (see Check 1)"; return; }
  [ -z "$PYTHON" ] && { skip "python not available to parse resolved config"; return; }
  if "$PYTHON" - "$CONFIG_JSON_FILE" "$PUBLIC_HTTP_PORT" "$BALANCE_UPSTREAM" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
port, balance = sys.argv[2], sys.argv[3]
services = cfg.get("services") or {}
bad = False

def published(svc):
    out = []
    for p in (svc.get("ports") or []):
        pub = p.get("published") if isinstance(p, dict) else None
        out.append("" if pub is None else str(pub))
    return out

ng = services.get("public-nginx")
if ng is None:
    print("  -> 'public-nginx' not defined"); bad = True
else:
    pubs = published(ng)
    if port in pubs:
        print(f"  public-nginx host-publishes :{port} (the public entrypoint)")
    else:
        print(f"  -> public-nginx does NOT host-publish :{port} (got {pubs or '(none)'})"); bad = True
    nets = set((ng.get("networks") or {}).keys())
    if "edge-public" in nets:
        print("  public-nginx on 'edge-public'")
    else:
        print(f"  -> public-nginx not on 'edge-public' (nets: {sorted(nets)})"); bad = True

for name in ("public-kong", balance):
    svc = services.get(name)
    if svc is None:
        print(f"  -> '{name}' not defined"); bad = True; continue
    pubs = [p for p in published(svc) if p != ""]
    if pubs:
        print(f"  -> '{name}' host-publishes {pubs} — must be UNPUBLISHED (reachable only via the nginx edge)"); bad = True
    else:
        print(f"  '{name}' host-publishes nothing (internal-only)")
sys.exit(1 if bad else 0)
PY
  then pass "public-nginx publishes only :$PUBLIC_HTTP_PORT on edge-public; public-kong + $BALANCE_UPSTREAM are unpublished"
  else fail "public-edge topology violates the macro: an internal service is host-published, or public-nginx is mis-wired"
  fi
}

# Check 3 (static) — the PUBLIC-kong declarative config exists, PARSES, and declares the
# security-critical intents of spec 06 (task item 7: "Kong declarative config parses").
# The current mechanism (developer ruling) is a single `pre-function` (serverless-functions,
# priority 1000000, runs FIRST) that OWNS the identity gate in Lua; `cors` and `rate-limiting`
# are the only other plugins. So the intents live as Lua in the pre-function block, NOT as
# separate jwt/acl/request-transformer plugins. This check asserts the REAL intents against
# the pre-function shape, tolerant of formatting AND (for future re-swaps) of the alternative
# plugin mechanisms — it FAILs only when a security-critical intent is ENTIRELY absent, or the
# file does not parse. Runtime checks 4-9 prove the behavior black-box.
#
# Intents asserted (all must be present):
#   * a NAMESPACED `/balance/api` route -> the balance upstream (developer routing ruling),
#     with `/balance` STRIPPED so the upstream still receives `/api` — NOT a bare `/api`;
#   * ANTI-SPOOF strip of BOTH X-User-Id AND X-Roles (before injection);
#   * RS256 algorithm pin + a JWKS signature VERIFY (not just claim reads);
#   * exact issuer match + `aud` contains supercool-api + exp/nbf expiry check;
#   * `customer` role gate with a 403 path;
#   * injection of BOTH X-User-Id AND X-Roles from the token;
#   * a rate-limiting plugin.
check_kong_declarative() {
  section "Check 3 (static) — public-kong config: parses + /balance/api route(strip->/api) + strip/RS256/iss/aud/exp/customer-gate/inject + rate-limit"
  local cfg; cfg="$(find_kong_public_config)"
  if [ -z "$cfg" ]; then
    fail "no public-kong declarative config found under infra/kong-public/ — the allowlist (exposed surface) is not defined"; return
  fi
  info "public-kong config: ${cfg#$REPO_ROOT/}"
  [ -z "$PYTHON" ] && { skip "python not available to parse the Kong declarative config"; return; }
  "$PYTHON" - "$cfg" "$BALANCE_UPSTREAM" "$CUSTOMER_ROLE" "$ISSUER" "$AUD" <<'PY'
import sys, json, re
path, balance, customer, issuer, aud = sys.argv[1:6]
raw = open(path, encoding='utf-8').read()
doc = None; parsed_via = None
try:
    import yaml
    doc = yaml.safe_load(raw); parsed_via = "yaml"
except ImportError:
    try:
        doc = json.loads(raw); parsed_via = "json"
    except Exception as e:
        print(f"  -> PyYAML unavailable and file is not JSON ({e}); doing a textual sanity pass"); parsed_via = None
except Exception as e:
    print(f"  -> declarative config does NOT parse as YAML: {e}"); sys.exit(2)

low = raw.lower()

# Textual fallback (only if no YAML/JSON parser). Weaker, but still catches gross gaps.
def textual_ok():
    problems = []
    if "/balance/api" not in raw:
        problems.append("no '/balance/api' namespaced route path (external surface must be namespaced)")
    if re.search(r'(^|\n)\s*-\s*/api\s*(\n|$)', raw):
        problems.append("a bare '/api' route path is present (must be namespaced /balance/api)")
    if "strip_path: false" in low:
        problems.append("strip_path:false present — /balance would not be stripped to /api upstream")
    if balance not in raw: problems.append(f"no reference to the '{balance}' upstream")
    if "rate-limiting" not in low: problems.append("no rate-limiting plugin")
    if "rs256" not in low: problems.append("no RS256 alg pin")
    if issuer not in raw: problems.append(f"no exact issuer literal '{issuer}'")
    if aud not in raw: problems.append(f"no expected audience '{aud}'")
    if customer not in raw or "403" not in raw:
        problems.append(f"no '{customer}' role gate with a 403 path")
    if not re.search(r'claims\s*[.\[]\s*["\']?exp\b', raw) and "claims_to_verify" not in low:
        problems.append("no exp/nbf expiry check (claims.exp)")
    # strip AND inject both reference each header name -> expect >=2 occurrences each.
    if low.count("x-user-id") < 2 or low.count("x-roles") < 2:
        problems.append("X-User-Id/X-Roles not both stripped AND injected")
    return problems

if doc is None:
    problems = textual_ok()
    if problems:
        for p in problems: print(f"  -> {p}")
        sys.exit(1)
    print("  textual sanity: /balance/api (namespaced, stripped), balance upstream, RS256, issuer, aud, customer-403, strip+inject, rate-limiting all present")
    sys.exit(0)

print(f"  declarative config parses ({parsed_via})")

services = doc.get("services") or []
routes_top = doc.get("routes") or []
plugins_top = doc.get("plugins") or []
def routes_of(svc): return svc.get("routes") or []

paths, plugins = [], list(plugins_top)
for s in services:
    plugins += (s.get("plugins") or [])
    for r in routes_of(s):
        paths += (r.get("paths") or [])
        plugins += (r.get("plugins") or [])
for r in routes_top:
    paths += (r.get("paths") or [])
    plugins += (r.get("plugins") or [])
names = [(p.get("name") or "").lower() for p in plugins]

# --- Route/strip shape (developer routing ruling): the EXTERNAL surface is namespaced
# `/balance/api` and Kong STRIPS `/balance` so the upstream still receives `/api`. We model
# the concrete probe `/balance/api/whoami` through each balance-service route and require the
# resulting UPSTREAM path to be `/api/whoami`. This FAILs if the route is left as bare `/api`,
# or if stripping is dropped (the un-stripped external path would then be forwarded). Accepts
# either the described shape (route `/balance/api` + strip + service path `/api`) or the
# equivalent (route `/balance` + strip + no service path) — mechanism-accurate, not brittle.
def targets_balance(s): return balance in json.dumps(s)
bal_services = [s for s in services if targets_balance(s)]

def service_path(s):
    p = s.get("path")
    if isinstance(p, str) and p:
        return p if p.startswith("/") else "/" + p
    url = s.get("url") or ""
    m = re.match(r'^[a-zA-Z][\w+.\-]*://[^/]+(/.*)?$', url)
    return (m.group(1) if m and m.group(1) else "")

route_info = []   # (route_path, strip_on, service_path)
for s in bal_services:
    sp = service_path(s)
    for r in routes_of(s):
        strip_on = (r.get("strip_path") is not False)   # Kong default strip_path = true
        for rp in (r.get("paths") or []):
            route_info.append((str(rp), strip_on, sp))

def upstream_path_for(rp, strip_on, sp, probe="/balance/api/whoami"):
    if not probe.startswith(rp):
        return None                       # this route would not match the probe
    remainder = probe[len(rp):] if strip_on else probe
    if strip_on and not remainder.startswith("/"):
        remainder = "/" + remainder
    up = (sp.rstrip("/") + remainder) if sp else remainder
    return re.sub(r'/{2,}', '/', up)

route_namespaced = any(rp.startswith("/balance") for rp, _, _ in route_info)
route_bare_api   = any(rp == "/api" or rp.startswith("/api/") for rp, _, _ in route_info)
route_ok = route_namespaced and not route_bare_api
# Stripping configured so the upstream receives /api (models the concrete probe).
strip_ok = any(rp.startswith("/balance") and upstream_path_for(rp, so, sp) == "/api/whoami"
               for rp, so, sp in route_info)

balance_service = bool(bal_services) or (balance in json.dumps(doc))
has_ratelimit = any("rate-limiting" in n for n in names)

# --- Extract the RAW Lua from serverless (pre/post-function) plugins. yaml.safe_load
# already un-escaped the YAML block scalar into a real multiline string, so quotes and
# newlines are literal -> regexes see `clear_header("X-User-Id")` as written (no JSON
# escaping). Config values are lists of code strings under phase keys (access/…) or
# `functions`, or a bare string.
lua_parts = []
for p in plugins:
    n = (p.get("name") or "").lower()
    if n in ("pre-function", "post-function", "serverless-functions"):
        cfg = p.get("config") or {}
        for val in cfg.values():
            if isinstance(val, list):
                lua_parts += [x for x in val if isinstance(x, str)]
            elif isinstance(val, str):
                lua_parts.append(val)
lua = "\n".join(lua_parts)
# Strip Lua line comments (-- to end of line) so a comment that merely MENTIONS an intent
# cannot satisfy its assertion — the real code must contain it. Lua uses `--` only for
# comments; none of this config's string literals contain `--` and there are no block
# comments, so a line strip is safe and sufficient here.
lua = re.sub(r'--[^\n]*', '', lua)
llow = lua.lower()

def hasrx(pat):  # case-insensitive regex over the raw Lua
    return re.search(pat, lua, re.I) is not None

# (1) ANTI-SPOOF strip of BOTH headers — Lua clear/remove header, OR a
# request-transformer remove.headers (alternative mechanism).
def rt_removes_both():
    for p in plugins:
        if "request-transformer" in (p.get("name") or "").lower():
            removes = ((p.get("config") or {}).get("remove") or {}).get("headers") or []
            rl = " ".join(str(x).lower() for x in removes)
            if "x-user-id" in rl and "x-roles" in rl:
                return True
    return False
strip_uid   = hasrx(r'(clear|remove)_header\s*\(\s*["\']x-user-id')
strip_roles = hasrx(r'(clear|remove)_header\s*\(\s*["\']x-roles')
strip_both  = (strip_uid and strip_roles) or rt_removes_both()

# (2) RS256 pin + a real signature VERIFY (not just claim reads).
alg_pin    = "rs256" in llow
sig_verify = hasrx(r'verify\s*\(') and ("signature" in llow)

# (3) Exact issuer literal + aud + expiry. exp/nbf must be the ACTUAL claim access
# (claims.exp / claims["exp"]) — NOT the bare word "exp", which also appears inside
# unrelated literals like EXPECTED_AUD (that would be tautological). Tolerant of a
# jwt-keycloak `claims_to_verify: [exp]` alternative.
iss_check = (issuer in lua) or (issuer in raw)
aud_check = (aud in lua) or (aud in raw)
def claims_to_verify_has_exp():
    for p in plugins:
        ctv = (p.get("config") or {}).get("claims_to_verify") or []
        if isinstance(ctv, list) and "exp" in [str(x) for x in ctv]:
            return True
    return False
exp_check = hasrx(r'claims\s*[.\[]\s*["\']?exp\b') or claims_to_verify_has_exp()

# (4) Customer role gate with a 403 path (403 vs 401), OR an acl/realm_roles plugin.
role_gate_lua = (customer in lua) and ("403" in lua) and ("realm_access" in llow or "roles" in llow)
role_gate_plugin = False
for p in plugins:
    n = (p.get("name") or "").lower(); c = p.get("config") or {}
    if n == "acl":
        allow = c.get("allow") or []
        if customer in [str(a) for a in allow]: role_gate_plugin = True
    for key in ("realm_roles", "roles", "required_roles"):
        vals = c.get(key) or []
        if isinstance(vals, list) and customer in [str(a) for a in vals]: role_gate_plugin = True
role_gate = role_gate_lua or role_gate_plugin

# (5) Inject BOTH identity headers from the token.
inject_uid   = hasrx(r'set_header\s*\(\s*["\']x-user-id')
inject_roles = hasrx(r'set_header\s*\(\s*["\']x-roles')
inject_both  = inject_uid and inject_roles

# (6) Bearer from Authorization only (reported; not a hard fail).
bearer_only = ("authorization" in llow) and ("bearer" in llow)

checks = [
    ("/balance/api route (namespaced, not bare /api)", route_ok),
    ("strip /balance -> upstream /api", strip_ok),
    (f"{balance} upstream", balance_service),
    ("strip X-User-Id + X-Roles (anti-spoof)", strip_both),
    ("RS256 alg pin", alg_pin),
    ("JWKS signature verify", sig_verify),
    (f"exact issuer '{issuer}'", iss_check),
    (f"aud contains '{aud}'", aud_check),
    ("exp/nbf expiry check", exp_check),
    (f"'{customer}' role gate (403)", role_gate),
    ("inject X-User-Id + X-Roles", inject_both),
    ("rate-limiting plugin", has_ratelimit),
]
problems = [label for label, ok in checks if not ok]
for label, ok in checks:
    print(f"    {'OK ' if ok else '-> MISSING'} {label}")
print(f"    {'OK ' if bearer_only else 'note'} bearer-from-Authorization-only")
sys.exit(1 if problems else 0)
PY
  local prc=$?
  case $prc in
    0) pass "public-kong config parses; /balance/api(strip->/api)->$BALANCE_UPSTREAM with strip-both + RS256 verify + iss/aud/exp + '$CUSTOMER_ROLE'-gate(403) + inject-both + rate-limiting" ;;
    2) fail "public-kong declarative config does NOT parse (see error above)" ;;
    *) fail "public-kong declarative config is missing a security-critical intent (see -> lines above)" ;;
  esac
}

# ==================================================================================
# RUNTIME CHECKS (need the FULL stack already up; reached via the published :PUBLIC_HTTP_PORT)
# ==================================================================================

# Check 4 (runtime, VERTICAL SLICE) — a real demo-customer token -> GET /balance/api/whoami
# on the public edge -> 200 with body { userId == token sub, roles contains 'customer' }. A
# 200 with the correct body also proves Kong STRIPPED /balance to the upstream /api/whoami.
# This is
# the spec-06 vertical slice: token validated by Kong, identity INJECTED as X-User-Id, the
# request reached the balance service, response returned. (DoD: "Valid customer token ->
# /api reaches the balance service with injected X-User-Id"; "Vertical slice is green".)
check_vertical_slice() {
  section "Check 4 (runtime) — vertical slice: demo-customer token -> GET /balance/api/whoami -> 200, userId==sub, roles has '$CUSTOMER_ROLE'"
  if [ -z "$CUSTOMER_TOKEN" ]; then
    skip "no demo-customer token available (see NOTE above) — vertical slice needs a real token; manual checkpoint in README"
    return
  fi
  [ -z "$PYTHON" ] && { skip "python not available to assert the JSON body"; return; }
  curl_probe "$(whoami_url)" -H "Authorization: Bearer $CUSTOMER_TOKEN"
  if [ "$PROBE_CODE" != "200" ]; then
    fail "whoami returned HTTP $PROBE_CODE (expected 200) — the customer token did not reach the balance service. Body: $(printf '%s' "$PROBE_BODY" | head -c 200)"
    return
  fi
  # Self-calibrate the upstream marker: a genuinely-proxied 200 tells us which Kong
  # header (if any) marks "reached upstream", for use by the negative checks below.
  if printf '%s' "$PROBE_HEADERS" | grep -qi '^x-kong-upstream-latency:'; then
    UPSTREAM_MARKER="x-kong-upstream-latency"
    info "upstream marker confirmed: 'X-Kong-Upstream-Latency' present on the proxied 200"
  fi
  if "$PYTHON" - "$CUSTOMER_SUB" "$CUSTOMER_ROLE" "$PROBE_BODY" <<'PY'
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
  then
    pass "vertical slice GREEN: valid customer token -> /balance/api/whoami 200 with userId==sub and roles including '$CUSTOMER_ROLE'"
  else
    fail "vertical slice: whoami 200 but the echoed identity is wrong (Kong injected the wrong X-User-Id/X-Roles)"
  fi
}

# Check 5 (runtime) — NO token -> 401, rejected AT KONG (never reaches the upstream).
# (DoD: "missing/invalid token -> 401 at Kong".) A balance-service 401 carries the
# {error:{...,requestId}} envelope; a Kong 401 does not — so we assert the request did
# NOT reach the balance service (reached_balance false), which distinguishes an edge
# rejection from a "Kong let it through and the app rejected it" misconfiguration.
check_no_token_401() {
  section "Check 5 (runtime) — no token -> 401 at Kong (request never reaches the balance service)"
  curl_probe "$(whoami_url)"
  local bad=0
  if [ "$PROBE_CODE" = "401" ]; then
    info "no-token request -> HTTP 401"
  else
    fail "no-token request -> HTTP $PROBE_CODE (expected 401). Body: $(printf '%s' "$PROBE_BODY" | head -c 160)"; bad=1
  fi
  if reached_balance "$PROBE_BODY" "$PROBE_HEADERS"; then
    fail "the no-token 401 came FROM the balance service (response has the app envelope/marker) — Kong let an unauthenticated request through to the upstream"; bad=1
  else
    info "the 401 came from the edge, not the balance service (no app envelope/upstream marker)"
  fi
  [ "$bad" -eq 0 ] && pass "unauthenticated /api request is rejected 401 at the edge and never reaches the balance service"
}

# Check 6 (runtime) — INVALID tokens -> 401. Covers a MALFORMED bearer and a token with a
# TAMPERED signature (real header/payload, flipped signature byte) — the latter proves Kong
# actually verifies the JWKS signature rather than trusting an unsigned/forged token.
# EXPIRED is validated by the same `exp` check; minting an already-expired but validly-signed
# token headlessly needs a >300s wait, so it is an OPT-IN slow test (TRANSPORT_TEST_EXPIRY=1).
check_bad_tokens_401() {
  section "Check 6 (runtime) — invalid token -> 401 (malformed + tampered-signature; expiry opt-in)"
  local bad=0
  # Malformed bearer.
  curl_probe "$(whoami_url)" -H "Authorization: Bearer not-a-real.jwt.value"
  if [ "$PROBE_CODE" = "401" ] && ! reached_balance "$PROBE_BODY" "$PROBE_HEADERS"; then
    info "malformed bearer -> 401 at the edge"
  else
    fail "malformed bearer -> HTTP $PROBE_CODE (want 401 from the edge); reached_balance=$(reached_balance "$PROBE_BODY" "$PROBE_HEADERS" && echo yes || echo no)"; bad=1
  fi
  # Tampered signature (needs a real token to tamper). Mutate a char in the MIDDLE of the
  # signature segment: flipping only the LAST base64url char can be a no-op (an RS256
  # signature's final char encodes just the top 2 bits of the last byte, so e.g. 'A'->'B'
  # decodes to the same final byte -> the signature is unchanged and a CORRECT gateway
  # returns 200, flakily reding this check). A middle char maps to full signature bytes, so
  # the decoded signature deterministically differs -> RS256 verify must fail with 401.
  if [ -n "$CUSTOMER_TOKEN" ]; then
    local jh jp js tampered mid ch newch
    IFS='.' read -r jh jp js <<EOF
$CUSTOMER_TOKEN
EOF
    mid=$(( ${#js} / 2 ))
    ch="${js:mid:1}"
    if [ "$ch" = "A" ]; then newch="B"; else newch="A"; fi
    tampered="${jh}.${jp}.${js:0:mid}${newch}${js:mid+1}"
    curl_probe "$(whoami_url)" -H "Authorization: Bearer $tampered"
    if [ "$PROBE_CODE" = "401" ] && ! reached_balance "$PROBE_BODY" "$PROBE_HEADERS"; then
      info "tampered-signature token -> 401 at the edge (JWKS signature genuinely verified)"
    else
      fail "tampered-signature token -> HTTP $PROBE_CODE (want 401 from the edge) — Kong may not be verifying the JWT signature. Body: $(printf '%s' "$PROBE_BODY" | head -c 160)"; bad=1
    fi
  else
    skip "tampered-signature sub-check needs a real token (none minted) — malformed-token rejection still asserted above"
  fi
  # Opt-in expiry (slow: waits out the ~300s access-token lifespan).
  if [ "${TRANSPORT_TEST_EXPIRY:-0}" = "1" ] && [ -n "$CUSTOMER_TOKEN" ]; then
    info "TRANSPORT_TEST_EXPIRY=1 — minting a fresh token and waiting for it to expire (~5-6 min)…"
    local fresh
    CUSTOMER_TOKEN=""; mint_customer_token >/dev/null 2>&1; fresh="$CUSTOMER_TOKEN"
    if [ -n "$fresh" ]; then
      sleep 310
      curl_probe "$(whoami_url)" -H "Authorization: Bearer $fresh"
      if [ "$PROBE_CODE" = "401" ] && ! reached_balance "$PROBE_BODY" "$PROBE_HEADERS"; then
        pass "expired token -> 401 at the edge (exp enforced)"
      else
        fail "expired token -> HTTP $PROBE_CODE (want 401) — Kong may not enforce 'exp'"; bad=1
      fi
    else
      skip "expiry sub-check: could not mint a fresh token to age out"
    fi
  else
    info "expiry sub-check skipped (set TRANSPORT_TEST_EXPIRY=1 to run the slow ~5min variant); the malformed + tampered checks already exercise Kong's JWT validation path"
  fi
  [ "$bad" -eq 0 ] && pass "invalid tokens (malformed, tampered signature) are rejected 401 at the edge and never reach the balance service"
}

# Check 7 (runtime, ANTI-SPOOF — MONEY-SAFETY, highest value) — the trust boundary:
#  (a) WITH a valid customer token AND spoofed X-User-Id + X-Roles: admin, the upstream
#      whoami reflects the TOKEN identity (userId==sub, roles has 'customer', roles does
#      NOT contain the spoofed 'admin') — Kong STRIPPED the client headers and re-injected
#      from the token, so a customer cannot self-elevate by sending headers.
#  (b) WITHOUT a token but WITH spoofed X-User-Id + X-Roles, the request is still 401 and
#      never reaches the balance service — a spoofed header is never trusted as identity.
# (DoD: "A client-supplied X-User-Id header is stripped before the upstream.")
check_anti_spoof() {
  section "Check 7 (runtime, MONEY-SAFETY) — client-supplied X-User-Id/X-Roles are stripped (anti-spoof)"
  local bad=0
  # (a) token + spoofed headers.
  if [ -n "$CUSTOMER_TOKEN" ] && [ -n "$PYTHON" ]; then
    curl_probe "$(whoami_url)" \
      -H "Authorization: Bearer $CUSTOMER_TOKEN" \
      -H "X-User-Id: spoofed-attacker-id" \
      -H "X-Roles: admin,superuser"
    if [ "$PROBE_CODE" != "200" ]; then
      fail "(a) token+spoof -> HTTP $PROBE_CODE (expected 200). Body: $(printf '%s' "$PROBE_BODY" | head -c 160)"; bad=1
    elif "$PYTHON" - "$CUSTOMER_SUB" "$CUSTOMER_ROLE" "$ADMIN_ROLE" "$PROBE_BODY" <<'PY'
import sys, json
sub, customer, admin, body = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
d = json.loads(body)
bad = False
uid = d.get("userId")
if uid == "spoofed-attacker-id":
    print("  -> userId is the SPOOFED value — Kong did NOT strip the client X-User-Id (identity spoofing!)"); bad = True
elif uid == sub:
    print(f"  (a) userId == token sub ('{sub}'), NOT the spoofed header")
else:
    print(f"  -> userId '{uid}' is neither the sub nor the spoof — unexpected injected identity"); bad = True
roles = d.get("roles") or []
if isinstance(roles, str): roles = [roles]
if admin in roles or "superuser" in roles:
    print(f"  -> roles contains a SPOOFED role {roles} — a customer self-elevated via X-Roles (privilege escalation!)"); bad = True
elif customer in roles:
    print(f"  (a) roles reflects the token ('{customer}'), spoofed 'admin'/'superuser' stripped")
else:
    print(f"  -> roles '{roles}' does not reflect the token role '{customer}'"); bad = True
sys.exit(1 if bad else 0)
PY
    then
      info "(a) with a valid token, spoofed X-User-Id/X-Roles are stripped and the token identity wins"
    else
      fail "(a) spoofed client headers leaked to the upstream — the trust boundary is broken"; bad=1
    fi
  else
    skip "(a) token+spoof sub-check needs a real token (none minted) — the header-only spoof (b) still runs"
  fi
  # (b) spoofed headers, NO token.
  curl_probe "$(whoami_url)" \
    -H "X-User-Id: spoofed-attacker-id" \
    -H "X-Roles: customer,admin"
  if [ "$PROBE_CODE" = "401" ] && ! reached_balance "$PROBE_BODY" "$PROBE_HEADERS"; then
    info "(b) spoofed X-User-Id/X-Roles with NO token -> 401 at the edge (header alone is never trusted)"
  else
    fail "(b) spoofed headers with no token -> HTTP $PROBE_CODE (want 401) / reached_balance=$(reached_balance "$PROBE_BODY" "$PROBE_HEADERS" && echo yes || echo no) — a forged X-User-Id was trusted as identity (auth bypass!). Body: $(printf '%s' "$PROBE_BODY" | head -c 160)"; bad=1
  fi
  [ "$bad" -eq 0 ] && pass "client-supplied X-User-Id/X-Roles are stripped: token identity wins, and a header alone never authenticates"
}

# Check 7b (runtime, CUSTOMER-ROLE GATE) — the spec's "acl (require customer)" intent,
# proven behaviorally: a VALID token that LACKS the `customer` realm role (demo-admin, who
# carries only `admin`) must be REJECTED at /api — it must NOT reach the balance service as
# an authorized customer. 403 is the semantically-correct code (authenticated, wrong role);
# a non-customer token yielding 200 would mean the public edge does not require `customer`.
check_role_gate() {
  section "Check 7b (runtime) — a valid token WITHOUT the '$CUSTOMER_ROLE' role is rejected at /api (customer-role gate)"
  local admin_token
  admin_token="$(pkce_token_for_role "$ADMIN_ROLE" 2>/dev/null)"
  if [ -z "$admin_token" ]; then
    skip "could not mint a valid non-customer (demo-admin) token — role-gate behavior not exercised; Check 3 asserts the gate statically"
    return
  fi
  # Sanity: confirm this token really lacks 'customer' (else the test proves nothing).
  local roles
  roles="$(decode_jwt_claims "$admin_token" | awk -F'\t' '$1=="realm_roles"{print $2}')"
  case " $roles " in
    *" $CUSTOMER_ROLE "*)
      skip "the minted non-customer token unexpectedly carries '$CUSTOMER_ROLE' (roles: $roles) — cannot test the gate"; return ;;
  esac
  info "minted a valid token carrying roles [$roles] (no '$CUSTOMER_ROLE')"
  curl_probe "$(whoami_url)" -H "Authorization: Bearer $admin_token"
  local bad=0
  if [ "$PROBE_CODE" = "200" ] || reached_balance "$PROBE_BODY" "$PROBE_HEADERS"; then
    fail "a valid token lacking '$CUSTOMER_ROLE' reached /api (HTTP $PROBE_CODE) — the customer-role gate is not enforced (any authenticated user could reach the customer API). Body: $(printf '%s' "$PROBE_BODY" | head -c 160)"; bad=1
  else
    info "non-customer token -> HTTP $PROBE_CODE, did not reach the balance service"
    [ "$PROBE_CODE" = "403" ] || info "(403 is the ideal code for authenticated-but-wrong-role; got $PROBE_CODE — still a rejection)"
  fi
  [ "$bad" -eq 0 ] && pass "the customer-role gate holds: a valid token without '$CUSTOMER_ROLE' is rejected at /api (HTTP $PROBE_CODE)"
}

# Check 9 (runtime, DEFAULT-DENY) — the public edge exposes ONLY the namespaced
# /balance/api surface on the app. Everything else must NOT reach the balance service via
# the public edge: a random non-/api path, the un-namespaced bare /api (no longer routed),
# /balance/admin (admin must be unreachable on the public plane), the bare /admin, and
# /internal. (spec 06: "Routes only <the allowlisted surface> -> balance-service.
# Default-deny everything else"; /admin belongs to the internal edge, Step 2; /internal is
# never routable from either edge.)
check_default_deny() {
  section "Check 9 (runtime) — default-deny: non-/api, bare /api, /balance/admin, /admin and /internal do not reach the balance service via the public edge"
  local bad=0 auth=()
  [ -n "$CUSTOMER_TOKEN" ] && auth=(-H "Authorization: Bearer $CUSTOMER_TOKEN")
  # probe: path ; human label
  local probe label
  for pair in \
    "/__scfin_default_deny_probe__|a random non-/api path" \
    "/api/whoami|the un-namespaced bare /api (must no longer route to the app)" \
    "/balance/admin/whoami|/balance/admin (admin must be unreachable on the public plane)" \
    "/admin/whoami|the bare /admin surface" \
    "/internal/whoami|/internal (never routable from any edge)"; do
    probe="${pair%%|*}"; label="${pair#*|}"
    curl_probe "$(edge_base)${probe}" "${auth[@]}"
    if reached_balance "$PROBE_BODY" "$PROBE_HEADERS"; then
      fail "$label reached the balance service via the PUBLIC edge (path '$probe', HTTP $PROBE_CODE, app envelope/marker present) — default-deny is broken. Body: $(printf '%s' "$PROBE_BODY" | head -c 160)"; bad=1
    else
      info "$label -> HTTP $PROBE_CODE, did not reach the balance service"
    fi
  done
  [ "$bad" -eq 0 ] && pass "default-deny holds on the public edge: only /balance/api reaches the balance service; non-/api, bare /api, /balance/admin, /admin and /internal do not"
}

# Check 8 (runtime, RATE-LIMITING) — a burst of AUTHENTICATED /api requests eventually
# returns 429. (DoD: "Rate limiting triggers on the auth/money routes.") The identity gate
# (pre-function, priority 1000000) runs BEFORE rate-limiting (901) and 401s unauthenticated
# traffic, so a valid token is required for requests to reach the rate-limiter's per-IP
# counter; run LAST so the consumed budget cannot affect the functional checks. Burst size
# is taken from the Kong config's configured limit when discoverable, else a generous default.
check_rate_limiting() {
  section "Check 8 (runtime) — a burst of authenticated /api requests eventually returns 429 (rate limiting)"
  if [ -z "$CUSTOMER_TOKEN" ]; then
    skip "rate-limit check needs a valid token so requests pass auth before hitting the limiter (none minted)"
    return
  fi
  local limit burst
  limit="$(detect_rate_limit)"
  if [ -n "$limit" ] && [ "$limit" -gt 0 ] 2>/dev/null; then
    burst=$((limit + 5)); [ "$burst" -gt 400 ] && burst=400
    info "configured limit ~${limit}/window (from Kong config); bursting up to $burst requests"
  else
    burst=150
    info "rate limit not discoverable from config; bursting up to $burst requests"
  fi
  local i code got429=0
  for ((i=1; i<=burst; i++)); do
    code="$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $CUSTOMER_TOKEN" "$(whoami_url)" 2>/dev/null)"
    if [ "$code" = "429" ]; then got429=1; info "request #$i -> 429 (rate limit tripped)"; break; fi
  done
  if [ "$got429" -eq 1 ]; then
    pass "rate limiting triggers: a burst on /api returned HTTP 429 (DoD)"
  else
    fail "no 429 within $burst authenticated /api requests — rate limiting does not trigger on the auth/money route (or the limit is set impractically high)"
  fi
}

# Read a numeric rate-limit (minute/second/hour) from the public-kong config to size the burst.
detect_rate_limit() {
  local cfg; cfg="$(find_kong_public_config)"
  [ -n "$cfg" ] || { printf ''; return 1; }
  [ -n "$PYTHON" ] || { printf ''; return 1; }
  "$PYTHON" - "$cfg" <<'PY' 2>/dev/null
import sys, json
raw = open(sys.argv[1], encoding='utf-8').read()
doc = None
try:
    import yaml; doc = yaml.safe_load(raw)
except Exception:
    try: doc = json.loads(raw)
    except Exception: doc = None
vals = []
if isinstance(doc, (dict, list)):
    def walk(o):
        if isinstance(o, dict):
            if (o.get("name") or "").lower().startswith("rate-limiting"):
                cfg = o.get("config") or {}
                for k in ("second", "minute", "hour", "day"):
                    v = cfg.get(k)
                    if isinstance(v, int): vals.append(v)
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(doc)
print(min(vals) if vals else "")
PY
}

# ----------------------------------------------------------------------------------
# Live-edge readiness
# ----------------------------------------------------------------------------------
edge_reachable() {
  local code
  code="$(curl -s --max-time 6 -o /dev/null -w '%{http_code}' "$(edge_base)/" 2>/dev/null)"
  [ -n "$code" ] && [ "$code" != "000" ]
}

# ----------------------------------------------------------------------------------
# Phase runners
# ----------------------------------------------------------------------------------
run_static() {
  section "STATIC CHECKS (no live stack; docker CLI + python)"
  load_env_values
  check_compose_config
  check_public_edge_topology
  check_kong_declarative
}

run_runtime() {
  section "RUNTIME CHECKS (need the FULL stack up: docker compose up)"
  load_env_values
  if ! command -v curl >/dev/null 2>&1; then
    skip "curl not installed — runtime checks 4-9 need it to drive the edge"; return
  fi
  if ! edge_reachable; then
    skip "the public edge is not reachable at $(edge_base) — bring the full stack up first ('docker compose up -d'); runtime checks 4-9 skipped (never a false pass)"
    return
  fi
  info "public edge reachable at $(edge_base)"

  # Mint a real demo-customer token (Authorization-Code + PKCE). Token-dependent checks
  # SKIP cleanly if this cannot be done headlessly (see NOTE + README manual checkpoint).
  mint_customer_token || info "proceeding without a token; token-dependent checks will SKIP"

  check_vertical_slice
  check_no_token_401
  check_bad_tokens_401
  check_anti_spoof
  check_role_gate
  check_default_deny
  # Rate-limiting consumes budget for the current window — run it LAST.
  check_rate_limiting
}

# Idempotent cleanup of anything this suite creates; safe on any exit.
global_cleanup() {
  [ -n "${PKCE_SCRIPT:-}" ] && rm -f "$PKCE_SCRIPT" 2>/dev/null
  rm -f /tmp/scfin_transport_pkce_err 2>/dev/null
  [ -n "${CONFIG_JSON_FILE:-}" ] && rm -f "$CONFIG_JSON_FILE" 2>/dev/null
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
