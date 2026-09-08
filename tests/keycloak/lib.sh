#!/usr/bin/env bash
# lib.sh — shared helpers and all verification checks for the IDENTITY PROVIDER
# (Spec 02 — Keycloak: realm `supercool` imported at boot, three public+PKCE clients,
# realm roles customer/admin, seeded users, and the load-bearing shared-host-alias
# issuer so a browser-minted token validates unchanged inside the services).
#
# Sourced by run.sh; defines functions only, never exits.
#
# Checks are written FROM the spec (specs/02-keycloak.md + specs/00-architecture.md
# §2/§3/§5), NOT from the implementor's files: they assert the INTENDED invariants in
# the Definition of Done, so they can fail on a real defect. Names come from the Step-2
# coordination contract; where a value can vary (ports, admin creds, seed-user
# passwords) it is read from .env.example / the realm export, never hardcoded.
#
# Scope of THIS step: Keycloak's realm/clients/roles/users, PKCE login, token claims,
# and issuer consistency across host + the two app-* networks. Kong and the services do
# not exist yet (steps 3-4), so the "token validates inside a real service" half of the
# JWKS DoD line is deferred to the step-4 vertical slice; here we prove the achievable,
# load-bearing half: issuer byte-identical + JWKS reachable from both app networks.

# ----------------------------------------------------------------------------------
# Environment / globals
# ----------------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$REPO_ROOT/docker-compose.yml"
ENV_EXAMPLE="$REPO_ROOT/.env.example"
INFRA_DIR="$REPO_ROOT/infra"
TOOLS_DIR="$REPO_ROOT/tools"

# Coordination contract (spec 02 — Resolved). Exact names/values the suite asserts.
REALM="supercool"
ALIAS="keycloak.localtest.me"
EXPECTED_CLIENTS="client-app otp-app admin-app"
EXPECTED_ROLES="customer admin"

# Runtime project isolation — a name that cannot collide with any real stack, so
# teardown with -v can only ever remove THIS test's containers/volumes/networks.
PROJECT="scfin-keycloak-test"

CONFIG_JSON_FILE=""     # cached resolved-config JSON (temp path); cleaned on exit
LAST_CONFIG_ERR=""      # stderr of the last failed `docker compose config`
RUNTIME_ENVFILE=""      # temp copy of .env.example used for `up`; cleaned on exit
PKCE_SCRIPT=""          # temp path of the python PKCE flow script; cleaned on exit
REALM_EXPORT=""         # resolved path to the realm export JSON (find_realm_export)

# Values loaded from .env.example at runtime (load_env_values).
KEYCLOAK_PORT=""
KC_ADMIN_USER=""; KC_ADMIN_PW=""; KC_ADMIN_VARS=""
ISSUER=""               # canonical issuer, built from KEYCLOAK_PORT

# Resolved docker network names (runtime).
NET_APP_PUBLIC=""; NET_APP_INTERNAL=""

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

daemon_available() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

# ----------------------------------------------------------------------------------
# .env.example value reader (pure bash — runtime checks must not depend on python).
# Returns the LAST assignment for KEY, stripped of CR and surrounding quotes.
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
  KEYCLOAK_PORT="$(env_val KEYCLOAK_PORT)"; [ -n "$KEYCLOAK_PORT" ] || KEYCLOAK_PORT="8082"
  ISSUER="http://${ALIAS}:${KEYCLOAK_PORT}/realms/${REALM}"

  # Master-realm bootstrap admin — version-appropriate var names. Try KC 26+ names
  # first (KC_BOOTSTRAP_ADMIN_*), then the classic KEYCLOAK_ADMIN* names. Read whatever
  # the compose/.env.example actually use; never hardcode a credential.
  local u p
  u="$(env_val KC_BOOTSTRAP_ADMIN_USERNAME)"; p="$(env_val KC_BOOTSTRAP_ADMIN_PASSWORD)"
  if [ -n "$u" ] && [ -n "$p" ]; then
    KC_ADMIN_USER="$u"; KC_ADMIN_PW="$p"; KC_ADMIN_VARS="KC_BOOTSTRAP_ADMIN_USERNAME/KC_BOOTSTRAP_ADMIN_PASSWORD"; return
  fi
  u="$(env_val KEYCLOAK_ADMIN)"; p="$(env_val KEYCLOAK_ADMIN_PASSWORD)"
  if [ -n "$u" ] && [ -n "$p" ]; then
    KC_ADMIN_USER="$u"; KC_ADMIN_PW="$p"; KC_ADMIN_VARS="KEYCLOAK_ADMIN/KEYCLOAK_ADMIN_PASSWORD"; return
  fi
  KC_ADMIN_USER=""; KC_ADMIN_PW=""; KC_ADMIN_VARS=""
}

# ----------------------------------------------------------------------------------
# Realm-export discovery. The export may live under tools/keycloak/ (coordination
# contract) or be mounted from infra/keycloak/. Return the first plausible file.
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
  # Fallback: any *realm*.json under tools/keycloak or infra/keycloak.
  local f
  f="$(find "$TOOLS_DIR/keycloak" "$INFRA_DIR/keycloak" -type f -iname '*realm*.json' 2>/dev/null | head -1)"
  if [ -n "$f" ]; then REALM_EXPORT="$f"; printf '%s' "$f"; return 0; fi
  printf ''; return 1
}

# ----------------------------------------------------------------------------------
# Resolved-config helper — the canonical way to inspect the compose file.
#   Returns: 0 ok (CONFIG_JSON_FILE populated), 1 parse failed, 3 docker CLI absent.
# `docker compose config` needs the docker CLI but NOT the daemon, so this is static.
# It substitutes .env.example values via a throwaway --env-file so a real (git-ignored)
# .env is never touched or required.
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
    CONFIG_JSON_FILE="$out"
    rm -f "$tmpenv" "$err"
    return 0
  else
    LAST_CONFIG_ERR="$(cat "$err")"
    rm -f "$tmpenv" "$out" "$err"
    return 1
  fi
}

# Resolve the real Docker network name for a compose network key under $PROJECT.
compose_net_name() {
  docker network ls \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.network=$1" \
    --format '{{.Name}}' 2>/dev/null | head -1
}

# ----------------------------------------------------------------------------------
# Compose lifecycle helpers (isolated project; relative mounts resolve against
# --project-directory = repo root). Only postgres + keycloak are brought up: keycloak
# depends on the fresh `keycloak` DB/role that step-1's postgres init provisions on an
# empty volume — which this isolated project always is.
# ----------------------------------------------------------------------------------
compose_up() {
  docker compose -p "$PROJECT" --project-directory "$REPO_ROOT" --env-file "$RUNTIME_ENVFILE" \
    -f "$COMPOSE" up -d --no-build postgres keycloak
}
compose_down_v() {
  docker compose -p "$PROJECT" --project-directory "$REPO_ROOT" --env-file "$RUNTIME_ENVFILE" \
    -f "$COMPOSE" down -v --remove-orphans
}

# Host-side OIDC endpoints (via the published :KEYCLOAK_PORT; localhost avoids any
# dependency on public DNS resolution of the alias from the host).
kc_base()      { printf 'http://localhost:%s' "$KEYCLOAK_PORT"; }
# The browser-facing base: the shared alias host (== KC_HOSTNAME). The interactive
# login/PKCE flow MUST be driven against this host — Keycloak renders absolute action
# URLs and scopes session cookies to KC_HOSTNAME, and `start` mode enforces it — which
# is exactly the browser's view. `keycloak.localtest.me` is a public name resolving to
# 127.0.0.1 (spec 02 §3), so on a networked host it reaches the published :port.
alias_base()   { printf 'http://%s:%s' "$ALIAS" "$KEYCLOAK_PORT"; }
# Does the host resolve the shared alias to a loopback address? (Needed for the browser
# flow; if not, that check SKIPs — an environment limitation, never a false pass.)
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
disco_url()    { printf '%s/realms/%s/.well-known/openid-configuration' "$(kc_base)" "$REALM"; }
token_url()    { printf '%s/realms/%s/protocol/openid-connect/token' "$(kc_base)" "$REALM"; }

# Poll the discovery endpoint on the host until Keycloak serves the imported realm.
# This is the readiness gate AND direct evidence the realm import succeeded: a 200 on
# .../realms/supercool/... means the `supercool` realm exists and is served.
wait_keycloak_ready() {
  local timeout="${1:-180}" waited=0 interval=4 code
  while :; do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$(disco_url)" 2>/dev/null)"
    [ "$code" = "200" ] && return 0
    if [ "$waited" -ge "$timeout" ]; then return 1; fi
    sleep "$interval"; waited=$((waited + interval))
  done
}

# HTTP GET from INSIDE a container attached to $1 (a docker network), resolving the
# host via Docker's embedded DNS (the compose network alias). Uses busybox wget from
# the already-pulled alpine image so no extra image pull is needed. Prints body.
net_http_get() {  # $1 = network name  $2 = url
  docker run --rm --network "$1" alpine wget -qO- "$2" 2>/dev/null
}
net_http_code() { # $1 = network name  $2 = url  -> prints "OK"/"" via wget spider
  docker run --rm --network "$1" alpine sh -c "wget -q -O /dev/null '$2' && echo OK" 2>/dev/null
}

# Decode the payload of a JWT and print selected claims, one per line as KEY<TAB>VALUE:
#   sub, iss, aud (space-joined if array), realm_roles (space-joined from realm_access).
decode_jwt_claims() {  # $1 = access token
  [ -n "$PYTHON" ] || return 3
  "$PYTHON" - "$1" <<'PY'
import sys, json, base64
tok = sys.argv[1]
parts = tok.split('.')
if len(parts) < 2:
    print("ERROR\tnot-a-jwt"); sys.exit(1)
seg = parts[1]
seg += '=' * (-len(seg) % 4)
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

# Obtain a master-realm admin access token via the built-in `admin-cli` client
# (direct grant on the MASTER realm — the standard Keycloak admin bootstrap; it does
# NOT touch or weaken any `supercool` SPA client). Prints the token or nothing.
admin_token() {
  [ -n "$KC_ADMIN_USER" ] && [ -n "$KC_ADMIN_PW" ] || return 1
  local resp
  resp="$(curl -s \
    -d 'client_id=admin-cli' -d 'grant_type=password' \
    --data-urlencode "username=$KC_ADMIN_USER" \
    --data-urlencode "password=$KC_ADMIN_PW" \
    "$(kc_base)/realms/master/protocol/openid-connect/token" 2>/dev/null)"
  [ -n "$PYTHON" ] || { printf ''; return 1; }
  printf '%s' "$resp" | "$PYTHON" -c 'import sys,json; d=json.load(sys.stdin); print(d.get("access_token",""))' 2>/dev/null
}

# Admin REST GET -> prints body. $1 = bearer token, $2 = path under the admin base.
admin_get() { curl -s -H "Authorization: Bearer $1" "$(kc_base)/admin$2" 2>/dev/null; }

# ==================================================================================
# STATIC CHECKS (no daemon required — docker CLI + python + a JSON parse)
# ==================================================================================

# Check 1 (static) — compose config resolves AND a `keycloak` service is defined.
# Prerequisite for every other check; a missing service is a step-2-not-done FAIL.
check_service_defined() {
  section "Check 1 (static) — compose resolves & a 'keycloak' service is defined (DoD: imported at boot)"
  if [ ! -f "$COMPOSE" ]; then fail "docker-compose.yml not found at $COMPOSE"; return; fi
  if [ ! -f "$ENV_EXAMPLE" ]; then fail ".env.example not found — needed to resolve config"; return; fi
  build_config; local rc=$?
  case $rc in
    3) skip "docker CLI not installed — cannot run 'docker compose config'"; return ;;
    0) : ;;
    *) fail "docker compose config failed to parse:"; printf '%s\n' "$LAST_CONFIG_ERR" >&2; return ;;
  esac
  [ -z "$PYTHON" ] && { skip "python not available to parse resolved config"; return; }
  if "$PYTHON" - "$CONFIG_JSON_FILE" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
sys.exit(0 if "keycloak" in (cfg.get("services") or {}) else 1)
PY
  then pass "'keycloak' service is defined in the compose spine"
  else fail "no 'keycloak' service in docker-compose.yml — spec-02 not wired into the spine yet"
  fi
}

# Check 2 (static) — keycloak's compose SHAPE: networks, host port, network alias.
#   * on app-public + app-internal + data (spec 00 §2 membership), on NO edge-* net;
#   * host-publishes ONLY :KEYCLOAK_PORT (nothing outside {8080,8081,8082});
#   * carries the shared network alias `keycloak.localtest.me` on BOTH app-* networks
#     (so both Kongs resolve the same name the browser uses — the issuer-consistency
#     prerequisite, spec 02 §3 "shared host alias").
check_service_shape() {
  section "Check 2 (static) — keycloak networks/port/alias (spec 00 §2/§3; spec 02 shared-host-alias)"
  build_config; local rc=$?
  [ $rc -eq 3 ] && { skip "docker CLI absent — cannot resolve service shape"; return; }
  [ $rc -ne 0 ] && { fail "config did not parse — cannot check shape (see Check 1)"; return; }
  [ -z "$PYTHON" ] && { skip "python not available to parse resolved config"; return; }
  load_env_values
  if "$PYTHON" - "$CONFIG_JSON_FILE" "$ALIAS" "$KEYCLOAK_PORT" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
alias = sys.argv[2]; port = sys.argv[3]
svc = (cfg.get("services") or {}).get("keycloak")
bad = False
if svc is None:
    print("  'keycloak' service is not defined"); sys.exit(1)

nets = svc.get("networks") or {}
netkeys = set(nets.keys())
print(f"  keycloak networks: {sorted(netkeys) if netkeys else '(none)'}")
for required in ("app-public", "app-internal", "data"):
    if required not in netkeys:
        print(f"    -> MUST be attached to '{required}' (spec 00 §2)"); bad = True
for forbidden in sorted(n for n in netkeys if n.startswith("edge-")):
    print(f"    -> MUST NOT be on edge network '{forbidden}' (spec 00 §2: keycloak is not an edge member)"); bad = True

# Host port: exactly the keycloak port, nothing else / nothing random / nothing outside 8080-8082.
allowed = {"8080", "8081", "8082"}
ports = svc.get("ports") or []
published = []
for p in ports:
    pub = p.get("published") if isinstance(p, dict) else None
    pub = "" if pub is None else str(pub)
    if pub == "":
        print("    -> keycloak publishes an ephemeral/random host port (not allowed)"); bad = True; continue
    published.append(pub)
    if pub not in allowed:
        print(f"    -> keycloak host-publishes {pub} (only 8080/8081/8082 allowed; expected {port})"); bad = True
if port not in published:
    print(f"    -> keycloak does NOT host-publish the browser login port {port} (spec 00 §3)"); bad = True
if any(pp != port for pp in published):
    print(f"    -> keycloak publishes more than the login port: {published} (expected only {port})"); bad = True
print(f"  keycloak host-published ports: {published or '(none)'}")

# Network alias on BOTH app-* networks (both Kongs must resolve the shared name).
for req in ("app-public", "app-internal"):
    spec = nets.get(req) or {}
    aliases = (spec.get("aliases") or []) if isinstance(spec, dict) else []
    if alias in aliases:
        print(f"  alias '{alias}' present on '{req}' (browser+containers resolve the same name)")
    else:
        print(f"    -> alias '{alias}' MISSING on '{req}' (spec 02 §3: shared host alias) — got {aliases}")
        bad = True
sys.exit(1 if bad else 0)
PY
  then pass "keycloak: on app-public/app-internal/data (not edge), publishes only :$KEYCLOAK_PORT, alias '$ALIAS' on both app networks"
  else fail "keycloak compose shape violates spec 00 §2/§3 or spec 02's shared-host-alias"
  fi
}

# Check 3 (static) — boot configuration that makes the DoD achievable:
#   (a) --import-realm is in the keycloak command (else the realm is never imported);
#   (b) a realm-export file is mounted into Keycloak's import dir;
#   (c) KC_HOSTNAME* pins the issuer host to the shared alias `keycloak.localtest.me`
#       (spec 02 §3 — the single most common Keycloak-in-Docker failure);
#   (d) KC_DB=postgres and the keycloak store is wired to the `keycloak` database with
#       the keycloak role, password injected from env (spec 01 tie), NOT a bare literal.
check_boot_config() {
  section "Check 3 (static) — --import-realm, mounted export, KC_HOSTNAME alias, KC_DB wiring"
  build_config; local rc=$?
  [ $rc -eq 3 ] && { skip "docker CLI absent — cannot resolve boot config"; return; }
  [ $rc -ne 0 ] && { fail "config did not parse — cannot check boot config (see Check 1)"; return; }
  [ -z "$PYTHON" ] && { skip "python not available to parse resolved config"; return; }
  if "$PYTHON" - "$CONFIG_JSON_FILE" "$ALIAS" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
alias = sys.argv[2]
svc = (cfg.get("services") or {}).get("keycloak")
if svc is None:
    print("  'keycloak' service not defined"); sys.exit(1)
bad = False

# (a) --import-realm in the command/entrypoint args (it is a CLI arg, never an env var).
cmd = svc.get("command") or []
entry = svc.get("entrypoint") or []
if isinstance(cmd, str): cmd = cmd.split()
if isinstance(entry, str): entry = entry.split()
joined = " ".join(list(entry) + list(cmd))
if "--import-realm" in joined:
    print(f"  command imports the realm: '{joined.strip()}'")
else:
    print(f"  -> '--import-realm' NOT in keycloak command/entrypoint (realm would never import): '{joined.strip()}'")
    bad = True

# (b) a realm export is mounted into the import directory.
vols = svc.get("volumes") or []
targets = []
for v in vols:
    if isinstance(v, dict): targets.append(v.get("target", ""))
    elif isinstance(v, str):
        parts = v.split(":")
        targets.append(parts[1] if len(parts) >= 2 else parts[0])
if any("import" in (t or "") for t in targets):
    print(f"  realm export mounted into an import dir: {[t for t in targets if 'import' in (t or '')]}")
else:
    print(f"  -> no volume mounted into a Keycloak import dir (expected .../data/import): {targets}")
    bad = True

env = svc.get("environment") or {}
if isinstance(env, list):
    env = dict((kv.split("=", 1) + [""])[:2] for kv in env)
envstr = {k: ("" if v is None else str(v)) for k, v in env.items()}

# (c) KC_HOSTNAME* pins the shared alias (so token issuer == browser-and-container URL).
host_keys = {k: v for k, v in envstr.items() if k.upper().startswith("KC_HOSTNAME")}
if not host_keys:
    print("  -> no KC_HOSTNAME* set — issuer host is not pinned (browser vs container issuer will diverge)")
    bad = True
elif any(alias in v for v in host_keys.values()):
    print(f"  KC_HOSTNAME* pins the shared alias '{alias}': {host_keys}")
else:
    print(f"  -> KC_HOSTNAME* does not reference '{alias}' (issuer would not match spec 02 §3): {host_keys}")
    bad = True

# (d) KC_DB=postgres, wired to the `keycloak` database (spec 01 database-per-service).
kc_db = envstr.get("KC_DB", "")
if kc_db.lower() == "postgres":
    print("  KC_DB=postgres")
else:
    print(f"  -> KC_DB is '{kc_db}', expected 'postgres' (spec 02: KC_DB=postgres against the keycloak DB)")
    bad = True
db_blob = " ".join(f"{k}={v}" for k, v in envstr.items() if "DB" in k.upper())
if "keycloak" in db_blob:
    print("  keycloak store references the 'keycloak' database")
else:
    print(f"  -> keycloak DB env does not reference the 'keycloak' database (must not point at 'balance'): {db_blob}")
    bad = True
sys.exit(1 if bad else 0)
PY
  then pass "keycloak boots with --import-realm, a mounted export, KC_HOSTNAME pinned to '$ALIAS', KC_DB=postgres -> keycloak DB"
  else fail "keycloak boot config is missing --import-realm / the mounted export / the KC_HOSTNAME alias / correct KC_DB wiring"
  fi
}

# Check 4 (static) — REALM EXPORT declares exactly the contract, parsed straight from
# the JSON (no daemon). Proves the DoD's provisioning half at rest:
#   * realm == `supercool`, enabled;
#   * clients client-app/otp-app/admin-app all: enabled, publicClient=true, PKCE S256,
#     standardFlow (auth code) on, NON-empty redirectUris;
#   * realm roles customer + admin declared;
#   * >=1 user carrying `customer` and >=1 carrying `admin` (seeded so the demo works);
#   * a short access-token lifespan is configured (spec 02 token settings).
# (The "no direct-access-grants" security posture is asserted separately in Check 4b.)
check_realm_export() {
  section "Check 4 (static) — realm export declares the 3 clients (public+PKCE+auth-code), 2 roles, seeded users"
  local re; re="$(find_realm_export)"
  if [ -z "$re" ]; then
    fail "no realm export JSON found under tools/keycloak/ or infra/keycloak/ — realm cannot be imported"; return
  fi
  info "realm export: ${re#$REPO_ROOT/}"
  [ -z "$PYTHON" ] && { skip "python not available to parse the realm export"; return; }
  if "$PYTHON" - "$re" "$REALM" "$EXPECTED_CLIENTS" "$EXPECTED_ROLES" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding='utf-8'))
realm = sys.argv[2]
want_clients = sys.argv[3].split()
want_roles = sys.argv[4].split()
bad = False

if doc.get("realm") != realm:
    print(f"  -> realm is '{doc.get('realm')}', expected '{realm}'"); bad = True
if doc.get("enabled") is False:
    print("  -> realm is disabled (enabled:false)"); bad = True

clients = {c.get("clientId"): c for c in (doc.get("clients") or [])}
for cid in want_clients:
    c = clients.get(cid)
    if c is None:
        print(f"  -> client '{cid}' missing from the export"); bad = True; continue
    attrs = c.get("attributes") or {}
    problems = []
    if c.get("enabled") is False: problems.append("disabled")
    if c.get("publicClient") is not True: problems.append("not public (publicClient must be true)")
    if (attrs.get("pkce.code.challenge.method") or "") != "S256":
        problems.append(f"PKCE method != S256 (got {attrs.get('pkce.code.challenge.method')!r})")
    if c.get("standardFlowEnabled") is False:
        problems.append("standardFlowEnabled is false (Authorization Code disabled)")
    if not (c.get("redirectUris") or []):
        problems.append("no redirectUris (Authorization Code impossible)")
    # Audience contract at rest: an oidc-audience-mapper stamping aud=supercool-api.
    # Kong (spec 06) filters on aud=supercool-api, so a dropped/renamed mapper must FAIL here.
    mappers = c.get("protocolMappers") or []
    if not any(
        (m.get("protocolMapper") == "oidc-audience-mapper")
        and ((m.get("config") or {}).get("included.custom.audience") == "supercool-api")
        for m in mappers
    ):
        problems.append("no oidc-audience-mapper stamping included.custom.audience=='supercool-api' (aud contract; Kong spec 06 filters on aud=supercool-api)")
    if problems:
        print(f"  -> client '{cid}': " + "; ".join(problems)); bad = True
    else:
        print(f"  client '{cid}': public + PKCE S256 + auth-code, redirects set, aud=supercool-api mapper")

roles = {r.get("name") for r in ((doc.get("roles") or {}).get("realm") or [])}
for r in want_roles:
    if r in roles:
        print(f"  realm role '{r}' declared")
    else:
        print(f"  -> realm role '{r}' missing"); bad = True

# Seeded users: count who carry each realm role inline.
users = doc.get("users") or []
by_role = {r: 0 for r in want_roles}
for u in users:
    for r in (u.get("realmRoles") or []):
        if r in by_role: by_role[r] += 1
for r in want_roles:
    if by_role[r] >= 1:
        print(f"  >=1 seeded user carries realm role '{r}' ({by_role[r]})")
    else:
        print(f"  -> no seeded user carries realm role '{r}' (demo would have nobody to log in as)"); bad = True

# Short access-token lifespan (spec 02 token settings: ~5 min). Fail only if clearly
# not short (> 1h); report the exact value otherwise.
life = doc.get("accessTokenLifespan")
if life is None:
    print("  NOTE: accessTokenLifespan not set in export (realm default applies)")
elif int(life) > 3600:
    print(f"  -> accessTokenLifespan={life}s is not a short-lived token (spec 02: ~5 min)"); bad = True
else:
    print(f"  accessTokenLifespan={life}s (short-lived, per spec 02)")
sys.exit(1 if bad else 0)
PY
  then pass "realm export: '$REALM' with client-app/otp-app/admin-app (public+PKCE S256+auth-code), roles customer+admin, seeded users"
  else fail "realm export does not satisfy the spec-02 contract (client/role/user/PKCE/flow defect above)"
  fi
}

# Check 4b (static, SECURITY POSTURE LOCK) — the public SPA clients must use Authorization
# Code + PKCE ONLY: no Direct Access Grants (ROPC / password grant), no implicit flow, no
# service accounts (client-credentials), and no consent screen. Spec 02 lists these clients
# as "Authorization Code + PKCE"; each toggle is a downgrade for a public SPA in a safety-
# critical money system — ROPC mints tokens from a password with no browser flow, implicit
# leaks tokens in the URL fragment, and a service account gives a public client a machine
# identity. The realm export currently has all four OFF; this check is the standing lock
# that FAILS if any is ever re-enabled. It stays isolated from the structural Check 4 so a
# documented posture waiver could never mask the realm/client/role proof.
check_client_posture() {
  section "Check 4b (static) — SPA clients: Authorization Code + PKCE ONLY (no ROPC / implicit / service-accounts / consent)"
  local re; re="$(find_realm_export)"
  if [ -z "$re" ]; then fail "no realm export found — cannot verify client security posture"; return; fi
  [ -z "$PYTHON" ] && { skip "python not available to parse the realm export"; return; }
  if "$PYTHON" - "$re" "$EXPECTED_CLIENTS" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding='utf-8'))
want = sys.argv[2].split()
clients = {c.get("clientId"): c for c in (doc.get("clients") or [])}
bad = False
for cid in want:
    c = clients.get(cid)
    if c is None:
        print(f"  -> client '{cid}' missing"); bad = True; continue
    cbad = False
    if c.get("directAccessGrantsEnabled") is True:
        print(f"  -> client '{cid}': directAccessGrantsEnabled is TRUE - ROPC/password grant on a public client (spec 02: Authorization Code + PKCE only)"); bad = True; cbad = True
    # Implicit flow leaks tokens in the redirect URL fragment; a public SPA must be
    # Authorization Code + PKCE only. serviceAccountsEnabled would give a *public* client
    # a client-credentials grant (a machine identity), also a downgrade. Both must stay off.
    if c.get("implicitFlowEnabled") is True:
        print(f"  -> client '{cid}': implicitFlowEnabled is TRUE — the implicit flow leaks tokens in the URL fragment (public SPA must be Authorization Code + PKCE only)"); bad = True; cbad = True
    if c.get("serviceAccountsEnabled") is True:
        print(f"  -> client '{cid}': serviceAccountsEnabled is TRUE — a public SPA client must not hold a service account (client-credentials grant)"); bad = True; cbad = True
    if c.get("consentRequired") is True:
        print(f"  -> client '{cid}': consentRequired is TRUE — a consent screen would block first-boot login"); bad = True; cbad = True
    if not cbad:
        print(f"  client '{cid}': direct grants off, implicit off, service accounts off, no consent screen")
sys.exit(1 if bad else 0)
PY
  then pass "client-app/otp-app/admin-app use Authorization Code + PKCE only (no ROPC, no implicit flow, no service accounts, no consent screen)"
  else fail "a public SPA client enables Direct Access Grants (ROPC) / implicit flow / service accounts / a consent screen — see README (posture lock)"
  fi
}

# Check 5 (static, no-secrets) — the MASTER admin bootstrap password must come from env,
# never be committed. The demo SEED-USER passwords in the realm export are intentional
# and allowed; this check targets ONLY the master admin credential.
#   (a) the admin-password placeholder VALUE from .env.example must not appear in any
#       other tracked file (compose/realm/infra baking it in is a leak);
#   (b) the compose keycloak service must set the admin password via an env reference
#       (${VAR}), not a bare literal.
check_no_committed_admin_secret() {
  section "Check 5 (static) — master admin password comes from env, not committed (CLAUDE.md no-secrets)"
  command -v git >/dev/null 2>&1 || { skip "git not installed — cannot scan tracked files"; return; }
  git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || { skip "not a git repository"; return; }
  [ -f "$ENV_EXAMPLE" ] || { skip ".env.example not found — no placeholder admin value to trace"; return; }
  load_env_values

  local bad=0 val hits
  # (a) trace the admin-password placeholder value (whichever var name is in use).
  val="$KC_ADMIN_PW"
  if [ -z "$val" ]; then
    fail "no master admin password var documented in .env.example (KC_BOOTSTRAP_ADMIN_PASSWORD or KEYCLOAK_ADMIN_PASSWORD) — cannot verify it is env-driven"
    return
  fi
  if [ "${#val}" -ge 4 ]; then
    hits="$(git -C "$REPO_ROOT" grep -n -F -e "$val" -- . ':!.env.example' ':!tests/' 2>/dev/null)"
    if [ -n "$hits" ]; then
      fail "the master admin password value is hardcoded in a tracked file (must come from env):"
      printf '%s\n' "$hits" | sed 's/^/      /' >&2
      bad=1
    fi
  else
    info "admin password placeholder too short to trace reliably (<4 chars) — value-leak scan skipped"
  fi

  # (b) compose must set the admin password via ${VAR}, not a literal.
  if [ -n "$PYTHON" ] && [ -f "$COMPOSE" ]; then
    if "$PYTHON" - "$COMPOSE" <<'PY'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
# Find lines assigning an admin password key; flag any that is a bare literal.
pat = re.compile(r'(KC_BOOTSTRAP_ADMIN_PASSWORD|KEYCLOAK_ADMIN_PASSWORD)\s*[:=]\s*(.+)$')
flagged = []
for i, line in enumerate(text.splitlines(), 1):
    s = line.strip()
    if s.startswith('#'): continue
    m = pat.search(s)
    if not m: continue
    val = m.group(2).strip().strip('"').strip("'")
    if '$' not in val:                 # no ${VAR} / $VAR reference -> a baked literal
        flagged.append(f"{i}: {s}")
for f in flagged:
    print("  " + f)
sys.exit(1 if flagged else 0)
PY
    then :
    else
      fail "compose sets the Keycloak admin password to a bare literal (must use an env reference \${VAR})"
      bad=1
    fi
  fi

  [ "$bad" -eq 0 ] && pass "master admin password is env-driven and not leaked into any tracked file (demo seed-user passwords are exempt)"
}

# ==================================================================================
# RUNTIME CHECKS (require Docker daemon + a wired keycloak service)
# ==================================================================================

# Check 6 (runtime) — `docker compose up` imports the realm and serves it.
# Readiness == a 200 on the supercool discovery doc, which by definition means the
# realm imported and Keycloak is serving it. Proves DoD "up imports the realm".
check_up_and_serving() {
  section "Check 6 (runtime) — 'up' imports the realm; discovery for 'supercool' serves (DoD: up imports realm)"
  if wait_keycloak_ready 180; then
    pass "Keycloak came up and serves the imported '$REALM' realm (discovery doc 200 on host :$KEYCLOAK_PORT)"
    return 0
  fi
  fail "Keycloak did not serve the '$REALM' discovery doc within timeout — realm import failed or KC did not start"
  # Give `logs` the same --env-file the dc()/compose_* wrappers use: the compose file
  # interpolates ${KEYCLOAK_PORT} in keycloak's `ports:`, so without it this subcommand
  # errors "no port specified" and prints NO logs exactly when they are needed.
  info "recent keycloak logs:"; docker compose -p "$PROJECT" --project-directory "$REPO_ROOT" --env-file "$RUNTIME_ENVFILE" -f "$COMPOSE" logs --tail=40 keycloak 2>&1 | sed 's/^/      /' >&2
  return 1
}

# Check 7 (runtime) — provisioning verified via the admin REST API. Proves DoD
# "imports the realm with clients, roles, and seed users" end-to-end (not just at rest):
# the realm exists, all three clients are present, both roles exist, and >=1 user is
# mapped to each role. A negative control (a bogus clientId returns empty) proves the
# check discriminates present from absent rather than always passing.
check_admin_api_provisioning() {
  section "Check 7 (runtime) — realm/clients/roles/users present via admin REST API (DoD provisioning)"
  if [ -z "$KC_ADMIN_USER" ] || [ -z "$KC_ADMIN_PW" ]; then
    fail "master admin creds not documented in .env.example (KC_BOOTSTRAP_ADMIN_* or KEYCLOAK_ADMIN*) — cannot query the admin API"; return
  fi
  [ -n "$PYTHON" ] || { skip "python not available to parse admin API responses"; return; }
  local tok; tok="$(admin_token)"
  if [ -z "$tok" ]; then
    fail "could not obtain a master admin token (admin-cli password grant failed) — check the bootstrap admin creds"; return
  fi
  local bad=0 body

  body="$(admin_get "$tok" "/realms/$REALM")"
  if printf '%s' "$body" | "$PYTHON" -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("realm")=="'"$REALM"'" else 1)' 2>/dev/null; then
    info "realm '$REALM' exists"
  else
    fail "admin API does not report realm '$REALM' (got: $(printf '%s' "$body" | head -c 200))"; bad=1
  fi

  local c present
  for c in $EXPECTED_CLIENTS; do
    body="$(admin_get "$tok" "/realms/$REALM/clients?clientId=$c")"
    present="$(printf '%s' "$body" | "$PYTHON" -c 'import sys,json;
d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)' 2>/dev/null)"
    if [ "${present:-0}" -ge 1 ]; then info "client '$c' present"; else fail "client '$c' NOT found via admin API"; bad=1; fi
  done
  # Negative control — a client that must NOT exist.
  body="$(admin_get "$tok" "/realms/$REALM/clients?clientId=scfin-bogus-should-not-exist")"
  present="$(printf '%s' "$body" | "$PYTHON" -c 'import sys,json;
d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)' 2>/dev/null)"
  if [ "${present:-0}" -eq 0 ]; then info "negative control ok: bogus clientId returns no client"; else fail "negative control FAILED: a bogus clientId matched — the presence check cannot discriminate"; bad=1; fi

  body="$(admin_get "$tok" "/realms/$REALM/roles")"
  local r hasrole
  for r in $EXPECTED_ROLES; do
    hasrole="$(printf '%s' "$body" | "$PYTHON" -c 'import sys,json;
d=json.load(sys.stdin); print(1 if any(x.get("name")=="'"$r"'" for x in d) else 0)' 2>/dev/null)"
    if [ "${hasrole:-0}" -eq 1 ]; then info "realm role '$r' exists"; else fail "realm role '$r' NOT found via admin API"; bad=1; fi
  done

  # >=1 user mapped to each realm role.
  local ucount
  for r in $EXPECTED_ROLES; do
    body="$(admin_get "$tok" "/realms/$REALM/roles/$r/users")"
    ucount="$(printf '%s' "$body" | "$PYTHON" -c 'import sys,json;
d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)' 2>/dev/null)"
    if [ "${ucount:-0}" -ge 1 ]; then info ">=1 user carries role '$r' ($ucount)"; else fail "no user is mapped to role '$r' — the seeded $r cannot log in"; bad=1; fi
  done

  [ "$bad" -eq 0 ] && pass "admin API confirms realm '$REALM' + clients [$EXPECTED_CLIENTS] + roles [$EXPECTED_ROLES] + a user per role"
}

# Check 8 (runtime, load-bearing) — ISSUER CONSISTENCY across the trust boundary.
# The spec's crux (spec 02 §3): the token `issuer` must be byte-identical as seen by
# the browser (host :port) AND by containers on the app networks (via the network
# alias). We fetch the discovery doc from the host and from a container on BOTH
# app-public and app-internal, and assert every `issuer` equals the canonical value.
# We also confirm JWKS is reachable from both app networks (the Kong-facing half).
# The remaining DoD half — "validates inside a real service" — needs Kong+services
# (steps 3-4) and is deferred to the step-4 vertical slice (noted in README).
check_issuer_consistency() {
  section "Check 8 (runtime) — issuer byte-identical on host + both app networks; JWKS reachable (DoD issuer consistency)"
  [ -n "$PYTHON" ] || { skip "python not available to parse discovery docs"; return; }
  local bad=0

  local host_disco host_iss host_jwks
  host_disco="$(curl -s "$(disco_url)" 2>/dev/null)"
  host_iss="$(printf '%s' "$host_disco" | "$PYTHON" -c 'import sys,json; print(json.load(sys.stdin).get("issuer",""))' 2>/dev/null)"
  host_jwks="$(printf '%s' "$host_disco" | "$PYTHON" -c 'import sys,json; print(json.load(sys.stdin).get("jwks_uri",""))' 2>/dev/null)"
  if [ -z "$host_iss" ]; then fail "could not read 'issuer' from the host discovery doc"; return; fi
  if [ "$host_iss" = "$ISSUER" ]; then
    info "host issuer == canonical: $host_iss"
  else
    fail "host issuer '$host_iss' != canonical '$ISSUER' (KC_HOSTNAME not pinned to the shared alias)"; bad=1
  fi

  # Resolve the app networks; the alias must resolve inside a container attached to each.
  NET_APP_PUBLIC="$(compose_net_name app-public)"
  NET_APP_INTERNAL="$(compose_net_name app-internal)"
  if ! docker image inspect alpine >/dev/null 2>&1; then docker pull alpine >/dev/null 2>&1 || true; fi
  if ! docker image inspect alpine >/dev/null 2>&1; then
    skip "'alpine' image unavailable — cannot probe the app networks from inside a container"
  else
    local net name disco iss jwks
    for pair in "app-public:$NET_APP_PUBLIC" "app-internal:$NET_APP_INTERNAL"; do
      name="${pair%%:*}"; net="${pair#*:}"
      if [ -z "$net" ]; then
        fail "network '$name' not found for project '$PROJECT' — keycloak may not be attached to it"; bad=1; continue
      fi
      disco="$(net_http_get "$net" "$(disco_url_alias)")"
      iss="$(printf '%s' "$disco" | "$PYTHON" -c 'import sys,json; print(json.load(sys.stdin).get("issuer",""))' 2>/dev/null)"
      jwks="$(printf '%s' "$disco" | "$PYTHON" -c 'import sys,json; print(json.load(sys.stdin).get("jwks_uri",""))' 2>/dev/null)"
      if [ -z "$iss" ]; then
        fail "from '$name': could not resolve '$ALIAS' or read discovery (network alias broken?)"; bad=1; continue
      fi
      if [ "$iss" = "$ISSUER" ] && [ "$iss" = "$host_iss" ]; then
        info "from '$name' (via alias): issuer byte-identical to host + canonical"
      else
        fail "from '$name': issuer '$iss' != host '$host_iss' / canonical '$ISSUER' — issuer NOT consistent across the trust boundary"; bad=1
      fi
      # JWKS reachable from this app network (what each Kong needs).
      if [ -n "$jwks" ] && [ -n "$(net_http_code "$net" "$jwks")" ]; then
        info "from '$name': JWKS reachable ($jwks)"
      else
        fail "from '$name': JWKS not reachable ($jwks) — a Kong on '$name' could not fetch signing keys"; bad=1
      fi
    done
  fi

  # JWKS reachable + non-empty from the host too (sanity that keys are actually served).
  if [ -n "$host_jwks" ]; then
    local keys
    keys="$(curl -s "$host_jwks" 2>/dev/null | "$PYTHON" -c 'import sys,json;
d=json.load(sys.stdin); print(len(d.get("keys") or []))' 2>/dev/null)"
    if [ "${keys:-0}" -ge 1 ]; then info "host JWKS serves $keys signing key(s)"; else fail "host JWKS has no keys"; bad=1; fi
  fi

  [ "$bad" -eq 0 ] && pass "issuer is byte-identical ('$ISSUER') on host + app-public + app-internal; JWKS reachable from both app networks"
}
# Container-side discovery URL uses the ALIAS host (proves the network alias resolves).
disco_url_alias() { printf 'http://%s:%s/realms/%s/.well-known/openid-configuration' "$ALIAS" "$KEYCLOAK_PORT" "$REALM"; }

# Check 9 (runtime, DoD 2 & 3) — a seeded customer and admin log in via a REAL
# Authorization-Code + PKCE (S256) flow, and the issued token carries the right claims.
# The flow is scripted end-to-end (auth request -> login form POST -> capture `code` ->
# token exchange WITH the code_verifier), so PKCE is genuinely exercised — no client is
# weakened with a password grant. For each user we assert:
#   sub present; iss == canonical issuer; realm-roles claim contains the expected role;
#   aud CONTAINS 'supercool-api' (the exact value Kong filters on, spec 06 — not merely
#   non-empty). Seed usernames+passwords are read from the realm export (demo values).
check_pkce_login() {
  section "Check 9 (runtime) — seeded customer & admin log in via Authorization-Code + PKCE; token claims correct (DoD 2 & 3)"
  local re; re="$(find_realm_export)"
  if [ -z "$re" ]; then fail "realm export not found — cannot recover seed-user demo credentials to drive PKCE"; return; fi
  [ -n "$PYTHON" ] || { skip "python not available — cannot run the scripted PKCE flow"; return; }
  # The browser flow must be driven against the shared alias host (== KC_HOSTNAME).
  if ! host_resolves_alias; then
    skip "Check 9 — host cannot resolve '$ALIAS' to loopback (offline env); the browser PKCE flow needs it. Config-level PKCE is proven in Checks 4/4b/7, issuer in Check 8."
    return
  fi
  local pkce_base; pkce_base="$(alias_base)"
  write_pkce_script

  local r
  for r in $EXPECTED_ROLES; do
    # Recover a seeded user for this role: username, plaintext demo password, and a
    # client that advertises a usable redirect URI. If the export stores only hashed
    # credentials we cannot drive a headless login -> honest SKIP (not a false pass).
    local trip user pass client redirect
    trip="$("$PYTHON" - "$re" "$r" "$EXPECTED_CLIENTS" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding='utf-8'))
role = sys.argv[2]; clients_order = sys.argv[3].split()
# pick a user with this realm role and a plaintext password credential.
def plaintext_pw(u):
    for c in (u.get("credentials") or []):
        if (c.get("type") == "password") and c.get("value") and not c.get("hashedSaltedValue"):
            return c.get("value")
    return None
user = None
for u in (doc.get("users") or []):
    if role in (u.get("realmRoles") or []) and plaintext_pw(u) and u.get("enabled", True):
        # a blocking required action would stop a first login; skip such users.
        if u.get("requiredActions"): continue
        user = u; break
if not user:
    print(""); sys.exit(0)
# choose a client + a concrete redirect (strip a trailing wildcard).
clients = {c.get("clientId"): c for c in (doc.get("clients") or [])}
redirect = None; chosen = None
for cid in clients_order:
    c = clients.get(cid)
    if not c: continue
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
      skip "Check 9 [$r] — no seeded '$r' user with a recoverable plaintext demo password + usable redirect in the export; cannot drive a headless PKCE login (config-level PKCE proven in Checks 4 & 7)"
      continue
    fi
    IFS=$'\t' read -r user pass client redirect <<EOF
$trip
EOF
    info "[$r] logging in as '$user' via client '$client' (PKCE S256), redirect '$redirect'"
    local token
    token="$("$PYTHON" "$PKCE_SCRIPT" "$pkce_base" "$REALM" "$client" "$redirect" "$user" "$pass" 2>/tmp/scfin_pkce_err)"
    if [ -z "$token" ]; then
      fail "[$r] scripted PKCE login did NOT yield an access token (a seeded $r must be able to log in via PKCE):"
      sed 's/^/        /' </tmp/scfin_pkce_err >&2 2>/dev/null
      rm -f /tmp/scfin_pkce_err
      continue
    fi
    rm -f /tmp/scfin_pkce_err

    # Decode + assert claims.
    local claims sub iss aud roles
    claims="$(decode_jwt_claims "$token")"
    sub="$(printf '%s\n' "$claims" | awk -F'\t' '$1=="sub"{print $2}')"
    iss="$(printf '%s\n' "$claims" | awk -F'\t' '$1=="iss"{print $2}')"
    aud="$(printf '%s\n' "$claims" | awk -F'\t' '$1=="aud"{print $2}')"
    roles="$(printf '%s\n' "$claims" | awk -F'\t' '$1=="realm_roles"{print $2}')"
    local bad=0
    if [ -n "$sub" ]; then info "[$r] token has sub=$sub"; else fail "[$r] token has no 'sub' (object-level authz would break)"; bad=1; fi
    if [ "$iss" = "$ISSUER" ]; then info "[$r] token iss == canonical issuer"; else fail "[$r] token iss '$iss' != canonical '$ISSUER'"; bad=1; fi
    case " $roles " in
      *" $r "*) info "[$r] realm-roles claim contains '$r' (roles: $roles)" ;;
      *)        fail "[$r] realm-roles claim does NOT contain '$r' (got: '$roles') — Kong ACL / admin checks would fail"; bad=1 ;;
    esac
    # aud VALUE, not just presence: decode_jwt_claims space-joins an array aud into a
    # single string, so wrapping in spaces lets us match the exact token 'supercool-api'.
    # Kong (spec 06) filters on aud=supercool-api, so a wrong/default audience must FAIL.
    case " $aud " in
      *" supercool-api "*) info "[$r] token aud contains 'supercool-api' (aud: $aud)" ;;
      *)                   fail "[$r] token aud '$aud' does NOT contain 'supercool-api' — Kong (spec 06) filters on aud=supercool-api, so this token would be rejected"; bad=1 ;;
    esac
    [ "$bad" -eq 0 ] && pass "[$r] '$user' logged in via PKCE; token carries sub, correct iss, role '$r', and aud=supercool-api"
  done
}

# Write the python Authorization-Code + PKCE flow to a temp file (kept out of the repo).
# It performs a REAL browser-style flow: auth GET (login page) -> credential POST
# (capture the 302 to redirect_uri) -> code exchange with the PKCE code_verifier.
# Prints the access_token on success; prints a diagnostic to stderr and exits non-zero
# otherwise. urllib is used (not curl) for reliable cookie + HTML handling; the exchange
# still requires the code_verifier, so PKCE is genuinely exercised.
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
        return None  # do not follow; we need to read the Location ourselves

follow  = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
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

# Extract the login form action (Keycloak: form id=kc-form-login / login-actions/authenticate).
m = (re.search(r'id="kc-form-login"[^>]*\baction="([^"]+)"', page)
     or re.search(r'\baction="([^"]+)"[^>]*id="kc-form-login"', page)
     or re.search(r'action="([^"]*login-actions/authenticate[^"]*)"', page))
if not m:
    print("could not locate the Keycloak login form action in the auth page "
          "(unexpected login theme, a consent/required-action screen, or an error page)",
          file=sys.stderr)
    sys.exit(1)
action = html.unescape(m.group(1))

form = urllib.parse.urlencode({"username": username, "password": password, "credentialId": ""}).encode()
FORM_CT = {"Content-Type": "application/x-www-form-urlencoded"}
try:
    resp = nofollow.open(urllib.request.Request(action, data=form, headers=FORM_CT), timeout=30)
    body = resp.read().decode("utf-8", "replace")
    # A 200 here means Keycloak re-rendered the login page => login was rejected.
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

# ----------------------------------------------------------------------------------
# Phase runners
# ----------------------------------------------------------------------------------
run_static() {
  section "STATIC CHECKS (no Docker daemon required)"
  check_service_defined
  check_service_shape
  check_boot_config
  check_realm_export
  check_client_posture
  check_no_committed_admin_secret
}

run_runtime() {
  section "RUNTIME CHECKS (require Docker daemon)"
  if ! command -v docker >/dev/null 2>&1; then skip "docker CLI not installed — runtime checks 6-9 skipped"; return; fi
  if ! docker info >/dev/null 2>&1; then skip "Docker daemon not reachable — runtime checks 6-9 skipped"; return; fi
  if ! command -v curl >/dev/null 2>&1; then skip "curl not installed — runtime checks 6-9 need it for OIDC calls"; return; fi
  [ -f "$COMPOSE" ]     || { fail "docker-compose.yml not found — cannot run runtime checks"; return; }
  [ -f "$ENV_EXAMPLE" ] || { fail ".env.example not found — cannot resolve runtime env"; return; }

  # Keycloak must be wired into the spine before any runtime check is meaningful.
  build_config
  if [ -n "$PYTHON" ] && [ -n "$CONFIG_JSON_FILE" ]; then
    if ! "$PYTHON" -c 'import json,sys; sys.exit(0 if "keycloak" in (json.load(open(sys.argv[1],encoding="utf-8")).get("services") or {}) else 1)' "$CONFIG_JSON_FILE" 2>/dev/null; then
      skip "runtime checks 6-9 — no 'keycloak' service in the compose spine yet (step 2 not implemented); static Check 1 already recorded this"
      return
    fi
  fi

  load_env_values
  ISSUER="http://${ALIAS}:${KEYCLOAK_PORT}/realms/${REALM}"

  RUNTIME_ENVFILE="$(mktemp)"; cp "$ENV_EXAMPLE" "$RUNTIME_ENVFILE"
  # Fresh slate for THIS isolated project (never touches another stack). A clean
  # postgres volume means step-1 init provisions the `keycloak` DB/role automatically.
  compose_down_v >/dev/null 2>&1

  info "bringing up postgres + keycloak under project '$PROJECT' (fresh volumes)"
  local err; err="$(mktemp)"
  if ! compose_up >/dev/null 2>"$err"; then
    if grep -qiE 'bind|allocated|address already in use|port is already|already in use' "$err"; then
      skip "runtime 6-9 — host port :$KEYCLOAK_PORT (or a container name) is already in use; stop your dev stack ('docker compose down') then re-run. This suite never tears down a stack it did not create."
    else
      fail "Check 6 — 'docker compose up postgres keycloak' failed:"; cat "$err" >&2
      skip "Checks 7-9 skipped (stack failed to start)"
    fi
    rm -f "$err"; compose_down_v >/dev/null 2>&1; return
  fi
  rm -f "$err"

  check_up_and_serving; local up=$?
  if [ "$up" -ne 0 ]; then
    skip "Checks 7-9 skipped — Keycloak is not serving the realm (see Check 6)"
    compose_down_v >/dev/null 2>&1; return
  fi

  check_admin_api_provisioning
  check_issuer_consistency
  check_pkce_login

  info "final teardown of project '$PROJECT' (with -v)"
  compose_down_v >/dev/null 2>&1
}

# Idempotent cleanup of everything this suite may create; safe on any exit.
# NB: the compose file interpolates ${KEYCLOAK_PORT} in keycloak's `ports:`, so even
# `down` must be given an env file or it errors with "no port specified" and tears
# down NOTHING. We always pass one (the runtime copy, or a throwaway from .env.example).
global_cleanup() {
  [ -n "${PKCE_SCRIPT:-}" ]      && rm -f "$PKCE_SCRIPT" 2>/dev/null
  rm -f /tmp/scfin_pkce_err 2>/dev/null
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && [ -f "$COMPOSE" ]; then
    local envf="" made=0
    if [ -n "${RUNTIME_ENVFILE:-}" ] && [ -f "$RUNTIME_ENVFILE" ]; then
      envf="$RUNTIME_ENVFILE"
    elif [ -f "$ENV_EXAMPLE" ]; then
      envf="$(mktemp)"; cp "$ENV_EXAMPLE" "$envf"; made=1
    fi
    if [ -n "$envf" ]; then
      docker compose -p "$PROJECT" --project-directory "$REPO_ROOT" --env-file "$envf" \
        -f "$COMPOSE" down -v --remove-orphans >/dev/null 2>&1
      [ "$made" -eq 1 ] && rm -f "$envf" 2>/dev/null
    fi
  fi
  [ -n "${CONFIG_JSON_FILE:-}" ] && rm -f "$CONFIG_JSON_FILE" 2>/dev/null
  [ -n "${RUNTIME_ENVFILE:-}" ]  && rm -f "$RUNTIME_ENVFILE" 2>/dev/null
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
