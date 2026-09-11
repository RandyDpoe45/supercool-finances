#!/usr/bin/env bash
# lib.sh — shared helpers and all verification checks for the PUBLIC-PLANE
# BUILD-AND-SERVE step of spec 08 (step 8-A). Sourced by run.sh; defines functions
# only, never exits.
#
# Checks are written FROM the spec (specs/08-build-and-serve.md — "Frontend build",
# the "Serving layout", "Ports & origin", the "Definition of Done" and its "Scope
# note"), NOT from the implementor's Dockerfiles / nginx config: each asserts an
# INTENDED invariant so it can fail on a real defect. Where a value can vary (host
# ports) it is read from .env.example; the client/otp SPA facts (titles, /otp/ base)
# come from the committed sources — never invented.
#
# The public-plane serving contract under test (spec 08, this pass):
#   browser -> http://localhost:${PUBLIC_HTTP_PORT}  (public-nginx, =8080; the ONLY
#     host-published public surface)
#       GET /            -> 200, the CLIENT SPA index          (client-app image)
#       GET /<deeplink>  -> 200, the CLIENT SPA index          (history fallback)
#       GET /otp/        -> 200, the OTP SPA index             (otp-app image)
#       GET /otp/<deep>  -> 200, the OTP SPA index             (history fallback)
#       GET /otp/assets/ -> 200, an /otp/-prefixed asset       (base '/otp/' applied,
#                                                               NOT stripped)
#       GET /balance/api/* -> reaches public-kong (401 w/o token / 5xx if kong down),
#                             NEVER a 200 SPA index (catch-all must not shadow the API)
#       GET /healthz     -> 200 (nginx liveness)
#   The SPA images join edge-public ONLY and are NOT host-published; the host-published
#   ports are the reserved trio public-nginx (:8080), internal-nginx (:8081) and keycloak
#   (:8082). :8081 (the internal/admin front door) landed in this admin pass and is now a
#   published reserved port.
#
# SCOPE: PUBLIC plane only. This suite proves the PUBLIC serving contract (client/otp SPAs
# behind public-nginx) plus the host-port contract. The admin SPA being SERVED and admin
# routing behind internal-nginx (:8081) are owned by the sibling tests/build-serve-admin/
# suite; here :8081 is admitted ONLY as an allowed published reserved port. The
# transfer-with-OTP / maker-checker e2e flows remain OUT (8-C). This suite proves the
# serving contract, not a money flow.

# ----------------------------------------------------------------------------------
# Environment / globals
# ----------------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$REPO_ROOT/docker-compose.yml"
ENV_EXAMPLE="$REPO_ROOT/.env.example"
INFRA_DIR="$REPO_ROOT/infra"
WEB_DIR="$REPO_ROOT/web"

# The compose service names the spec names explicitly ("`/` -> the client-app image;
# `/otp/` -> the otp-app image") and the front door.
CLIENT_SVC="client-app"
OTP_SVC="otp-app"
NGINX_SVC="public-nginx"
KEYCLOAK_SVC="keycloak"

# SPA index discriminators — taken from the committed sources (web/*/index.html).
# vite build preserves the <title>, so these survive the production build. The otp
# title is a SUPERSET of the client title, so match otp on the "OTP</title>" suffix
# (ASCII-safe; avoids the em-dash) and the client on the exact title.
CLIENT_TITLE='<title>SuperCool Finances</title>'
OTP_TITLE_MARK='OTP</title>'
SPA_ROOT_MARK='id="root"'   # any served SPA index carries the mount node

# Isolated compose project for the OPT-IN / auto self-up (never touches a real stack).
PROJECT="scfin-build-serve-test"

# Values loaded from .env.example at runtime.
PUBLIC_HTTP_PORT=""
KEYCLOAK_PORT=""
INTERNAL_HTTP_PORT=""     # :8081 — the internal/admin front door; a published reserved port

# Discovered artifacts / caches (cleaned on exit).
CONFIG_JSON_FILE=""       # cached resolved-config JSON (temp path)
LAST_CONFIG_ERR=""        # stderr of the last failed `docker compose config`
RUNTIME_ENVFILE=""        # temp copy of .env.example used for `up`; cleaned on exit
DC_FALLBACK_ENV=""
NGINX_CONF=""             # resolved path to the public-nginx config
SELF_UP_DONE=0            # 1 if THIS suite brought the edge up (=> must tear down)

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
  PUBLIC_HTTP_PORT="$(env_val PUBLIC_HTTP_PORT)";     [ -n "$PUBLIC_HTTP_PORT" ]   || PUBLIC_HTTP_PORT="8080"
  KEYCLOAK_PORT="$(env_val KEYCLOAK_PORT)";           [ -n "$KEYCLOAK_PORT" ]       || KEYCLOAK_PORT="8082"
  INTERNAL_HTTP_PORT="$(env_val INTERNAL_HTTP_PORT)"; [ -n "$INTERNAL_HTTP_PORT" ]  || INTERNAL_HTTP_PORT="8081"
}

edge_base()  { printf 'http://localhost:%s' "$PUBLIC_HTTP_PORT"; }
whoami_url() { printf '%s/balance/api/whoami' "$(edge_base)"; }

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
# so keycloak's ${KEYCLOAK_PORT} etc. interpolate).
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

find_nginx_public_conf() {
  [ -n "$NGINX_CONF" ] && { printf '%s' "$NGINX_CONF"; return 0; }
  local c
  for c in \
    "$INFRA_DIR/nginx-public/nginx.conf" \
    "$INFRA_DIR/nginx-public/default.conf" \
    "$INFRA_DIR/nginx_public/nginx.conf"; do
    [ -f "$c" ] && { NGINX_CONF="$c"; printf '%s' "$c"; return 0; }
  done
  c="$(find "$INFRA_DIR" -type f -iname '*.conf' 2>/dev/null \
        | while IFS= read -r f; do grep -qi 'balance/api\|listen\s' "$f" 2>/dev/null && { printf '%s\n' "$f"; break; }; done | head -1)"
  [ -n "$c" ] && { NGINX_CONF="$c"; printf '%s' "$c"; return 0; }
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

probe_ctype() { printf '%s' "$PROBE_HEADERS" | grep -i '^content-type:' | head -1 | tr -d '\r'; }

# --- SPA index discriminators (pure string tests over a response body) ---
is_spa_index()    { case "$1" in *"$SPA_ROOT_MARK"*) return 0 ;; *) return 1 ;; esac; }
is_otp_index()    { case "$1" in *"$OTP_TITLE_MARK"*) return 0 ;; *) return 1 ;; esac; }
# client index: the exact client title, OR a SPA index that is NOT the otp one.
is_client_index() {
  case "$1" in
    *"$CLIENT_TITLE"*) return 0 ;;
  esac
  if is_spa_index "$1" && ! is_otp_index "$1"; then return 0; fi
  return 1
}

# ==================================================================================
# STATIC CHECKS (no live stack; docker CLI + python + file reads)
# ==================================================================================

# Check 1 (static) — `docker compose config` resolves AND the public-plane serving
# trio (public-nginx, client-app, otp-app) is wired into the DEFAULT `up` graph
# (no profile gate). (spec 08 "Frontend build" / "Serving layout" / "Full run".)
# A missing SPA service = step-not-done; this FAILs until the implementor wires them.
check_compose_wiring() {
  section "Check 1 (static) — compose config resolves; public-nginx + client-app + otp-app wired into the default up graph"
  [ -f "$COMPOSE" ]     || { fail "docker-compose.yml not found at $COMPOSE"; return; }
  [ -f "$ENV_EXAMPLE" ] || { fail ".env.example not found — needed to resolve config"; return; }
  build_config; local rc=$?
  case $rc in
    3) skip "docker CLI not installed — cannot run 'docker compose config'"; return ;;
    0) : ;;
    *) fail "docker compose config failed to parse:"; printf '%s\n' "$LAST_CONFIG_ERR" >&2; return ;;
  esac
  [ -z "$PYTHON" ] && { skip "python not available to parse resolved config"; return; }
  if "$PYTHON" - "$CONFIG_JSON_FILE" "$NGINX_SVC" "$CLIENT_SVC" "$OTP_SVC" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
services = cfg.get("services") or {}
required = sys.argv[2:]
bad = False
for name in required:
    svc = services.get(name)
    if svc is None:
        print(f"  -> service '{name}' NOT defined in the spine (public plane not wired yet)"); bad = True; continue
    profiles = svc.get("profiles") or []
    if profiles:
        print(f"  -> service '{name}' is gated behind profile(s) {profiles} — it must be in the DEFAULT up graph"); bad = True
    else:
        print(f"  service '{name}' defined (default up graph)")
sys.exit(1 if bad else 0)
PY
  then pass "compose config resolves; $NGINX_SVC, $CLIENT_SVC, $OTP_SVC all in the default up graph"
  else fail "the public-plane serving trio is not fully wired into the default up graph"
  fi
}

# Check 2 (static, PORT CONTRACT) — the DoD: the ONLY host-published ports are the
# reserved trio :8080 (public-nginx), :8081 (internal-nginx / admin front door) and
# :8082 (keycloak). Anything published OUTSIDE that trio — a stray port, or a public
# SPA container (client-app / otp-app) — is a defect. Models the DEFAULT `up`
# (profile-gated services, e.g. the `seed` one, are not in that graph). (DoD "Only
# :8080/:8081/:8082 are published".) Whether the admin SPA is actually served / routed
# behind :8081 is the sibling tests/build-serve-admin/ suite's domain, not this one's.
check_port_contract() {
  section "Check 2 (static) — only the reserved trio :$PUBLIC_HTTP_PORT + :$INTERNAL_HTTP_PORT + :$KEYCLOAK_PORT is host-published; SPA containers + stray ports NOT"
  build_config; local rc=$?
  [ $rc -eq 3 ] && { skip "docker CLI absent — cannot resolve ports"; return; }
  [ $rc -ne 0 ] && { fail "config did not parse — cannot check ports (see Check 1)"; return; }
  [ -z "$PYTHON" ] && { skip "python not available to parse resolved config"; return; }
  if "$PYTHON" - "$CONFIG_JSON_FILE" "$PUBLIC_HTTP_PORT" "$KEYCLOAK_PORT" "$INTERNAL_HTTP_PORT" "$CLIENT_SVC" "$OTP_SVC" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
pub, kc, internal, client, otp = sys.argv[2:7]
allowed = {pub, internal, kc}
services = cfg.get("services") or {}
bad = False
published = {}   # port -> [services] (default up graph only)

def host_ports(svc):
    out = []
    for p in (svc.get("ports") or []):
        val = p.get("published") if isinstance(p, dict) else None
        if val is None:
            out.append("(ephemeral)"); continue
        out.append(str(val))
    return out

for name, svc in services.items():
    profiles = svc.get("profiles") or []
    hp = host_ports(svc)
    if profiles:
        if hp: print(f"  NOTE: profile-gated service '{name}' (profiles {profiles}) publishes {hp} — not in the default up graph, ignored")
        continue
    for port in hp:
        published.setdefault(port, []).append(name)

# 1) Nothing published outside the reserved trio (this is where a stray SPA/other port fails).
for port, owners in sorted(published.items()):
    if port == "(ephemeral)":
        print(f"  -> {owners} publish an ephemeral/random host port (not allowed)"); bad = True
    elif port not in allowed:
        print(f"  -> host port :{port} is published by {owners} — only the reserved trio :{pub}, :{internal}, :{kc} may be host-published"); bad = True
    else:
        print(f"  :{port} published by {owners} (allowed)")

# 2) Both required edges present.
if pub not in published:
    print(f"  -> :{pub} (public-nginx front door) is NOT host-published — the browser cannot reach the SPAs"); bad = True
if kc not in published:
    print(f"  -> :{kc} (keycloak) is NOT host-published — the browser cannot complete the OIDC redirect"); bad = True

# 3) The SPA images must be unpublished (reachable only via the public-nginx router).
for name in (client, otp):
    svc = services.get(name)
    if svc is None: continue   # Check 1 already fails on this
    if host_ports(svc):
        print(f"  -> SPA image '{name}' host-publishes {host_ports(svc)} — SPAs must join edge-public only, never host-published"); bad = True
sys.exit(1 if bad else 0)
PY
  then pass "port contract holds: only the reserved trio :$PUBLIC_HTTP_PORT + :$INTERNAL_HTTP_PORT + :$KEYCLOAK_PORT is published; SPA containers unpublished"
  else fail "port contract violated (a host port outside the reserved trio is published, or a required edge / SPA isolation is wrong) — see -> lines"
  fi
}

# Check 3 (static, SPA TOPOLOGY) — the SPA images join edge-public ONLY (so they are
# reachable solely through the public-nginx router) and publish nothing. (spec 08
# "Ports & origin": "The SPA images join edge-public only and are not host-published".)
check_spa_topology() {
  section "Check 3 (static) — client-app + otp-app on 'edge-public' only, host-published nothing"
  build_config; local rc=$?
  [ $rc -eq 3 ] && { skip "docker CLI absent — cannot resolve service shape"; return; }
  [ $rc -ne 0 ] && { fail "config did not parse — cannot check topology (see Check 1)"; return; }
  [ -z "$PYTHON" ] && { skip "python not available to parse resolved config"; return; }
  if "$PYTHON" - "$CONFIG_JSON_FILE" "$CLIENT_SVC" "$OTP_SVC" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
services = cfg.get("services") or {}
bad = False
for name in sys.argv[2:]:
    svc = services.get(name)
    if svc is None:
        print(f"  -> '{name}' not defined"); bad = True; continue
    nets = set((svc.get("networks") or {}).keys())
    if nets == {"edge-public"}:
        print(f"  {name} on exactly 'edge-public'")
    else:
        print(f"  -> {name} networks are {sorted(nets)} — must be exactly ['edge-public'] (router-only reachability)"); bad = True
    if svc.get("ports"):
        print(f"  -> {name} host-publishes ports {svc.get('ports')} — must be unpublished"); bad = True
sys.exit(1 if bad else 0)
PY
  then pass "client-app + otp-app are on edge-public only and host-publish nothing"
  else fail "SPA topology violates the macro (wrong network membership or a published SPA port)"
  fi
}

# Check 4 (static, NGINX ROUTER) — the public-nginx config, once wired for spec 08,
# (a) STILL routes /balance/api -> public-kong (the API is preserved, not shadowed);
# (b) serves the client SPA at / (the spec-06 default-deny `return 404` placeholder is
#     GONE);
# (c) has an /otp route; and reports whether that route STRIPS /otp/ (it must NOT — the
#     otp bundle is built for base '/otp/'); and
# (d) keeps the /healthz liveness endpoint.
# Robust, low-false-positive textual parse: FAILs only on clearly-detectable regressions;
# the definitive /otp/ base + serving proof is the runtime suite (Checks R3/R5).
check_nginx_router() {
  section "Check 4 (static) — public-nginx routes /balance/api->kong, serves client SPA at /, has /otp (unstripped), keeps /healthz"
  local conf; conf="$(find_nginx_public_conf)"
  [ -z "$conf" ] && { fail "no public-nginx config found under infra/ — cannot verify the router"; return; }
  info "public-nginx config: ${conf#$REPO_ROOT/}"
  [ -z "$PYTHON" ] && { skip "python not available to parse the nginx config"; return; }
  "$PYTHON" - "$conf" <<'PY'
import sys, re
raw = open(sys.argv[1], encoding='utf-8').read()

# Extract brace-balanced `location <matcher> { ... }` blocks.
blocks = []   # (matcher, body)
i = 0
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

problems = []

# (a) /balance/api still routed to public-kong (API preserved).
_, api_body = block_for(lambda mt: 'balance/api' in mt)
if api_body is None:
    problems.append("no `location .../balance/api` block — the API route was removed/shadowed")
elif 'public-kong' not in api_body:
    problems.append("the /balance/api block no longer proxies to `public-kong` (API not reaching the gateway)")
else:
    print("  OK  /balance/api -> public-kong preserved")

# (b) the root `location /` is no longer the spec-06 default-deny placeholder.
root_matcher, root_body = block_for(lambda mt: mt.strip() in ('/', '/ '))
if root_body is None:
    problems.append("no root `location /` block — the client SPA is not served at /")
elif re.search(r'\breturn\s+404\b', root_body):
    problems.append("root `location /` still `return 404` (spec-06 placeholder) — client SPA not wired at /")
else:
    served = ('client-app' in root_body) or ('proxy_pass' in root_body) or ('try_files' in root_body) or re.search(r'\broot\s', root_body)
    if served: print("  OK  root `location /` serves the client SPA (no 404 placeholder)")
    else: problems.append("root `location /` neither proxies to client-app nor serves a bundle (root/try_files)")

# (c) an /otp route exists; report strip status. In nginx, `proxy_pass http://otp-app:PORT;`
# (no path after host:port) KEEPS the /otp/ prefix; a trailing path (incl. bare `/`) STRIPS it.
otp_matcher, otp_body = block_for(lambda mt: re.search(r'/otp\b', mt))
if otp_body is None:
    problems.append("no `location .../otp` block — the OTP SPA is not routed")
else:
    print(f"  OK  /otp route present (matcher: {otp_matcher})")
    pp = re.search(r'proxy_pass\s+https?://[^/\s;]+(/[^\s;]*)?', otp_body)
    if pp:
        if pp.group(1):   # a path component after host:port -> nginx strips the location prefix
            problems.append(f"the /otp route STRIPS /otp/ (proxy_pass has a path '{pp.group(1)}') — the otp bundle is built for base '/otp/' and would 404 its assets")
        else:
            print("  OK  /otp proxy_pass keeps the /otp/ prefix (not stripped)")
    else:
        print("  note /otp route uses no proxy_pass (bundle served locally?) — runtime R5 verifies base '/otp/'")

# (d) /healthz liveness preserved.
hz_matcher, hz_body = block_for(lambda mt: 'healthz' in mt)
if hz_body is None or not re.search(r'\b200\b', hz_body):
    problems.append("no `location = /healthz` returning 200 — nginx liveness endpoint missing")
else:
    print("  OK  /healthz -> 200 liveness preserved")

for p in problems: print(f"  -> {p}")
sys.exit(1 if problems else 0)
PY
  local prc=$?
  case $prc in
    0) pass "public-nginx router: /balance/api->kong preserved, client SPA at /, /otp present (unstripped), /healthz 200" ;;
    *) fail "public-nginx router config regressed (see -> lines) — API shadowed, placeholder left, /otp missing/stripped, or /healthz dropped" ;;
  esac
}

# Check 5 (static, OPPORTUNISTIC) — if a built otp bundle is present (web/otp/dist or a
# discoverable build output), its index.html references /otp/-prefixed assets — i.e.
# `base: '/otp/'` was applied at build time. SKIPs (never fails) when no build artifact
# exists; the runtime R5 check proves this against the actually-served bundle.
check_built_otp_base() {
  section "Check 5 (static, opportunistic) — a built otp index.html references /otp/-prefixed assets (base applied)"
  local idx=""
  local c
  for c in \
    "$WEB_DIR/otp/dist/index.html" \
    "$WEB_DIR/otp/build/index.html"; do
    [ -f "$c" ] && { idx="$c"; break; }
  done
  if [ -z "$idx" ]; then
    skip "no built otp bundle found (web/otp/dist not present) — base '/otp/' proven at runtime (R5) instead"
    return
  fi
  info "built otp index: ${idx#$REPO_ROOT/}"
  local body; body="$(cat "$idx" 2>/dev/null)"
  # A built index MUST reference at least one hashed asset under /otp/ (script or link).
  if printf '%s' "$body" | grep -qiE '(src|href)="/otp/[^"]+"'; then
    if printf '%s' "$body" | grep -qiE '(src|href)="/assets/[^"]+"'; then
      fail "built otp index references ROOT-based /assets/ URLs — base '/otp/' not applied to all assets (they would 404 behind /otp/)"
    else
      pass "built otp index references /otp/-prefixed assets (base '/otp/' applied)"
    fi
  else
    fail "built otp index has no /otp/-prefixed asset reference — base '/otp/' was not applied at build time"
  fi
}

# ==================================================================================
# RUNTIME CHECKS (need the public edge reachable at :PUBLIC_HTTP_PORT)
# ==================================================================================

edge_reachable() {
  local code
  code="$(curl -s --max-time 6 -o /dev/null -w '%{http_code}' "$(edge_base)/healthz" 2>/dev/null)"
  [ -n "$code" ] && [ "$code" != "000" ]
}

# Are the SPA services actually defined? (Gate the self-up: don't run a compose `up`
# for services that do not exist yet — Check 1 already reports "not wired".)
public_plane_defined() {
  build_config || return 1
  [ -z "$PYTHON" ] && return 1
  "$PYTHON" - "$CONFIG_JSON_FILE" "$NGINX_SVC" "$CLIENT_SVC" "$OTP_SVC" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
services = cfg.get("services") or {}
sys.exit(0 if all(n in services for n in sys.argv[2:]) else 1)
PY
}

# Bring up JUST the public-plane serving pieces in the isolated project, LIGHT: with
# --no-deps so we don't drag up the whole backend chain (kong/keycloak/postgres). The
# API-not-shadowed proof (R6) still holds — /balance/api yields a 5xx (kong absent),
# which is NOT a 200 SPA index; the transport suite covers the 401-at-Kong specifics.
# Sets SELF_UP_DONE=1 on success so the phase runner tears it down afterward.
#   Returns: 0 up, 1 environmental failure (pull/build/offline -> caller SKIPs),
#            2 real up/build defect (-> caller FAILs), 3 name conflict (-> SKIP).
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
  info "self-up: building + starting $NGINX_SVC, $CLIENT_SVC, $OTP_SVC (--no-deps) under project '$PROJECT' (this can take a few minutes)…"
  local err rc; err="$(mktemp)"
  dc up -d --build --no-deps --wait "$NGINX_SVC" "$CLIENT_SVC" "$OTP_SVC" >/dev/null 2>"$err"; rc=$?
  if [ "$rc" -ne 0 ]; then
    local msg; msg="$(cat "$err")"; rm -f "$err"
    # Environmental (offline / registry / TLS) failures are NOT a spec defect -> SKIP.
    if printf '%s' "$msg" | grep -qiE 'network|timeout|temporary failure|could not resolve|lookup|tls|dial tcp|connection refused|no such host|pull access|manifest unknown|i/o timeout|EAI_AGAIN|registry'; then
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

# --- R7 — nginx liveness. GET /healthz -> 200 'ok'. ---
check_healthz() {
  section "R7 (runtime) — GET /healthz -> 200 (nginx liveness)"
  curl_probe "$(edge_base)/healthz"
  if [ "$PROBE_CODE" = "200" ]; then
    pass "GET /healthz -> 200 (front door is live)"
  else
    fail "GET /healthz -> HTTP $PROBE_CODE (expected 200) — the public front door is not serving its liveness endpoint"
  fi
}

# --- R1 — GET / -> 200 client SPA index. ---
check_client_root() {
  section "R1 (runtime) — GET / -> 200 serving the CLIENT SPA index"
  curl_probe "$(edge_base)/"
  if [ "$PROBE_CODE" != "200" ]; then
    fail "GET / -> HTTP $PROBE_CODE (expected 200) — the client SPA is not served at the root"; return
  fi
  if is_otp_index "$PROBE_BODY"; then
    fail "GET / returned the OTP index (title has 'OTP') — the root is misrouted to the otp bundle"; return
  fi
  if is_client_index "$PROBE_BODY"; then
    pass "GET / -> 200 with the client SPA index (title '$CLIENT_TITLE', $SPA_ROOT_MARK)"
  else
    fail "GET / -> 200 but the body is not the client SPA index (no client <title>/$SPA_ROOT_MARK). Body head: $(printf '%s' "$PROBE_BODY" | head -c 200)"
  fi
}

# --- R2 — client deep link -> 200 client index (history fallback). ---
check_client_deeplink() {
  section "R2 (runtime) — GET /accounts (deep link) -> 200 client index (SPA history fallback)"
  curl_probe "$(edge_base)/accounts"
  if [ "$PROBE_CODE" != "200" ]; then
    fail "GET /accounts -> HTTP $PROBE_CODE (expected 200) — SPA history fallback (try_files -> /index.html) is missing; a client deep link 404s on reload"; return
  fi
  if is_client_index "$PROBE_BODY" && ! is_otp_index "$PROBE_BODY"; then
    pass "GET /accounts -> 200 client index (history fallback serves the SPA shell)"
  else
    fail "GET /accounts -> 200 but not the client index (fallback served the wrong content). Body head: $(printf '%s' "$PROBE_BODY" | head -c 200)"
  fi
}

# --- R3 — GET /otp/ -> 200 otp SPA index. ---
check_otp_root() {
  section "R3 (runtime) — GET /otp/ -> 200 serving the OTP SPA index"
  curl_probe "$(edge_base)/otp/"
  if [ "$PROBE_CODE" != "200" ]; then
    fail "GET /otp/ -> HTTP $PROBE_CODE (expected 200) — the otp SPA is not served under /otp/"; return
  fi
  if is_otp_index "$PROBE_BODY"; then
    pass "GET /otp/ -> 200 with the OTP SPA index (title contains 'OTP')"
  elif is_client_index "$PROBE_BODY"; then
    fail "GET /otp/ returned the CLIENT index — /otp/ is misrouted to the client bundle"
  else
    fail "GET /otp/ -> 200 but the body is not the OTP SPA index. Body head: $(printf '%s' "$PROBE_BODY" | head -c 200)"
  fi
}

# --- R4 — otp deep link -> 200 otp index (history fallback). ---
check_otp_deeplink() {
  section "R4 (runtime) — GET /otp/pending (deep link) -> 200 otp index (SPA history fallback)"
  curl_probe "$(edge_base)/otp/pending"
  if [ "$PROBE_CODE" != "200" ]; then
    fail "GET /otp/pending -> HTTP $PROBE_CODE (expected 200) — otp SPA history fallback is missing; an otp deep link 404s on reload"; return
  fi
  if is_otp_index "$PROBE_BODY"; then
    pass "GET /otp/pending -> 200 otp index (history fallback serves the otp shell)"
  else
    fail "GET /otp/pending -> 200 but not the otp index (fallback served the wrong content / stripped /otp/). Body head: $(printf '%s' "$PROBE_BODY" | head -c 200)"
  fi
}

# --- R5 — the otp bundle references /otp/-prefixed assets AND one such asset loads 200
# with a script/style content-type. Proves base '/otp/' was applied AND the router
# serves /otp/ assets WITHOUT stripping the prefix. ---
check_otp_asset() {
  section "R5 (runtime) — the OTP bundle references an /otp/-prefixed asset and it loads 200"
  curl_probe "$(edge_base)/otp/"
  if [ "$PROBE_CODE" != "200" ]; then
    skip "cannot read the otp index (GET /otp/ -> $PROBE_CODE) — see R3"; return
  fi
  local asset
  asset="$(printf '%s' "$PROBE_BODY" | grep -oiE '(src|href)="/otp/[^"]+"' | head -1 | sed -E 's/^[^"]*"//; s/"$//')"
  if [ -z "$asset" ]; then
    fail "the served otp index references NO /otp/-prefixed asset — base '/otp/' was not applied (assets would resolve to the site root and 404 behind /otp/). Body head: $(printf '%s' "$PROBE_BODY" | head -c 200)"
    return
  fi
  info "otp index references asset: $asset"
  curl_probe "$(edge_base)${asset}"
  local ct; ct="$(probe_ctype)"
  if [ "$PROBE_CODE" != "200" ]; then
    fail "GET $asset -> HTTP $PROBE_CODE (expected 200) — the /otp/-prefixed asset does not load; the router likely strips /otp/ before the otp image"
    return
  fi
  case "$ct" in
    *javascript*|*ecmascript*|*text/css*|*application/json*|*text/html*)
      pass "an /otp/-prefixed asset ($asset) loads 200 (content-type: ${ct#content-type: }) — base applied, prefix not stripped" ;;
    *)
      # 200 with an unexpected type is still a served asset; report but don't hard-fail on MIME alone.
      info "asset content-type is '${ct:-<none>}' (unexpected for a JS/CSS bundle asset)"
      pass "an /otp/-prefixed asset ($asset) loads 200 — base applied, prefix not stripped" ;;
  esac
}

# --- R6 (highest-value routing invariant) — the SPA catch-all does NOT shadow the API.
# GET /balance/api/whoami with NO token must NOT return a 200 SPA index page. With a full
# stack it is a 401 from Kong; with the light self-up (kong absent) it is a 5xx — either
# way it must NOT be the client/otp index HTML. ---
check_api_not_shadowed() {
  section "R6 (runtime) — SPA catch-all does NOT shadow the API: GET /balance/api/whoami is not a 200 SPA page"
  curl_probe "$(whoami_url)"
  local bad=0
  if [ "$PROBE_CODE" = "200" ] && is_spa_index "$PROBE_BODY"; then
    fail "GET /balance/api/whoami -> 200 with a SPA index ($SPA_ROOT_MARK present) — the client catch-all SHADOWS the API route (requests to the gateway are being answered by the SPA!)"; bad=1
  elif is_spa_index "$PROBE_BODY"; then
    fail "GET /balance/api/whoami returned SPA index HTML (HTTP $PROBE_CODE) — the API path resolves to a SPA bundle, not the gateway"; bad=1
  fi
  if [ "$bad" -eq 0 ]; then
    if [ "$PROBE_CODE" = "401" ]; then
      info "GET /balance/api/whoami -> 401 (rejected at Kong; full stack up) — API correctly reaches the gateway, not the SPA"
    elif [ "$PROBE_CODE" = "000" ]; then
      fail "GET /balance/api/whoami -> no response (000) — the /balance/api location is not reachable at all"; bad=1
    else
      info "GET /balance/api/whoami -> HTTP $PROBE_CODE (not a SPA page) — /balance/api is proxied to the gateway (401 needs the full stack; kong may be absent in a light bring-up)"
    fi
  fi
  [ "$bad" -eq 0 ] && pass "the /balance/api route is not shadowed by the SPA catch-all (response is not a SPA index page)"
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
  check_built_otp_base
}

run_runtime() {
  load_env_values
  section "RUNTIME CHECKS (public edge reachable at :$PUBLIC_HTTP_PORT)"
  if ! command -v curl >/dev/null 2>&1; then
    skip "curl not installed — runtime checks need it to drive the edge"; return
  fi

  local attached=0
  if edge_reachable; then
    info "public edge already reachable at $(edge_base) — running black-box checks against the live stack"
    attached=1
  else
    if [ "${BUILD_SERVE_NO_SELFUP:-0}" = "1" ]; then
      skip "public edge not reachable at $(edge_base) and BUILD_SERVE_NO_SELFUP=1 — bring the stack up first ('docker compose up -d --build'); runtime checks skipped (never a false pass)"
      return
    fi
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
      skip "public edge not reachable and no Docker daemon to self-up — bring the stack up first; runtime checks skipped"
      return
    fi
    if ! public_plane_defined; then
      skip "public edge not reachable and the public-plane services are not wired yet (see Check 1) — cannot self-up; runtime checks skipped"
      return
    fi
    self_up; local rc=$?
    case $rc in
      0) : ;;
      2) fail "self-up: 'docker compose up --build' failed on a real defect (see above) — the public plane does not build/serve"; return ;;
      3) skip "self-up skipped (a conflicting stack is already running under other names) — 'docker compose down' then re-run"; return ;;
      *) skip "self-up could not bring the edge up in this environment (offline/registry) — bring the stack up manually then re-run"; return ;;
    esac
    if ! edge_reachable; then
      fail "self-up reported ready but the edge is still not reachable at $(edge_base) — public-nginx did not come up healthy"
      return
    fi
    info "public edge reachable at $(edge_base) (brought up by this suite)"
  fi

  check_healthz
  check_client_root
  check_client_deeplink
  check_otp_root
  check_otp_deeplink
  check_otp_asset
  check_api_not_shadowed
}

# Idempotent cleanup of anything this suite creates; safe on any exit.
global_cleanup() {
  self_down
  [ -n "${CONFIG_JSON_FILE:-}" ] && rm -f "$CONFIG_JSON_FILE" 2>/dev/null
  [ -n "${RUNTIME_ENVFILE:-}" ]  && rm -f "$RUNTIME_ENVFILE" 2>/dev/null
  [ -n "${DC_FALLBACK_ENV:-}" ]  && rm -f "$DC_FALLBACK_ENV" 2>/dev/null
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
