#!/usr/bin/env bash
# lib.sh — shared helpers and all verification checks for the STORAGE LAYER
# (Spec 01 — PostgreSQL two DBs + least-priv roles, Redis AUTH + AOF, Mongo auth +
# app user + `analytics` db, and the connection-string env contracts).
#
# Sourced by run.sh; defines functions only, never exits.
#
# Checks are written FROM the spec (specs/01-storage.md), not from the implementor's
# files: they assert the INTENDED invariants in the Definition of Done, so they can
# fail on a real defect. Names come from the Step-1 coordination contract; where a
# value can vary it is read from .env.example rather than hardcoded.
#
# Scope of THIS step: the three datastores' real config only. Keycloak / balance /
# analytics containers and the ledger/outbox schema are NOT part of this step and are
# not tested here. Network-level "data only" isolation is proven in tests/macro
# (Check 9); here we prove the AUTHENTICATED pings work on `data`.

# ----------------------------------------------------------------------------------
# Environment / globals
# ----------------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$REPO_ROOT/docker-compose.yml"
ENV_EXAMPLE="$REPO_ROOT/.env.example"
INFRA_DIR="$REPO_ROOT/infra"

# Runtime project isolation — a name that cannot collide with any real stack, so
# teardown with -v can only ever remove THIS test's containers/volumes/networks.
PROJECT="scfin-storage-test"

CONFIG_JSON_FILE=""     # cached resolved-config JSON (temp path); cleaned on exit
LAST_CONFIG_ERR=""      # stderr of the last failed `docker compose config`
RUNTIME_ENVFILE=""      # temp copy of .env.example used for `up`; cleaned on exit
DATA_NET=""             # resolved docker network name for the `data` network
LAST_HEALTH_STATUS=""   # status string from the last wait_health call

# Credentials / names loaded from .env.example at runtime (load_env_values).
POSTGRES_USER=""; POSTGRES_PASSWORD=""
BALANCE_DB=""; KEYCLOAK_DB=""
BAL_USER=""; BAL_PW=""
KC_USER=""; KC_PW=""
REDIS_PASSWORD=""
MONGO_ROOT_USER=""; MONGO_ROOT_PW=""
MONGO_APP_USER=""; MONGO_APP_PW=""; MONGO_DB=""
MONGO_APP_AUTHSRC=""

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
  # strip one layer of surrounding matching quotes
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  printf '%s' "$val"
}

load_env_values() {
  POSTGRES_USER="$(env_val POSTGRES_USER)"
  POSTGRES_PASSWORD="$(env_val POSTGRES_PASSWORD)"
  BALANCE_DB="$(env_val POSTGRES_DB)"; [ -n "$BALANCE_DB" ] || BALANCE_DB="balance"
  KEYCLOAK_DB="keycloak"   # fixed by the coordination contract (databases: balance, keycloak)
  BAL_USER="$(env_val POSTGRES_BALANCE_USER)"
  BAL_PW="$(env_val POSTGRES_BALANCE_PASSWORD)"
  KC_USER="$(env_val POSTGRES_KEYCLOAK_USER)"
  KC_PW="$(env_val POSTGRES_KEYCLOAK_PASSWORD)"
  REDIS_PASSWORD="$(env_val REDIS_PASSWORD)"
  MONGO_ROOT_USER="$(env_val MONGO_INITDB_ROOT_USERNAME)"
  MONGO_ROOT_PW="$(env_val MONGO_INITDB_ROOT_PASSWORD)"
  MONGO_APP_USER="$(env_val MONGO_APP_USER)"
  MONGO_APP_PW="$(env_val MONGO_APP_PASSWORD)"
  MONGO_DB="$(env_val MONGO_DB)"; [ -n "$MONGO_DB" ] || MONGO_DB="analytics"
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
# Compose lifecycle helpers (isolated project; relative init-script mounts resolve
# against --project-directory = repo root).
# ----------------------------------------------------------------------------------
cid() { docker compose -p "$PROJECT" --project-directory "$REPO_ROOT" -f "$COMPOSE" ps -q "$1" 2>/dev/null | head -1; }

compose_up() {
  docker compose -p "$PROJECT" --project-directory "$REPO_ROOT" --env-file "$RUNTIME_ENVFILE" \
    -f "$COMPOSE" up -d --no-build postgres redis mongo
}
compose_down_keepv() {
  docker compose -p "$PROJECT" --project-directory "$REPO_ROOT" --env-file "$RUNTIME_ENVFILE" \
    -f "$COMPOSE" down --remove-orphans
}
compose_down_v() {
  docker compose -p "$PROJECT" --project-directory "$REPO_ROOT" --env-file "$RUNTIME_ENVFILE" \
    -f "$COMPOSE" down -v --remove-orphans
}

# wait_health "<svc svc ...>" <timeout_s> -> 0 healthy, 1 timeout, 2 unhealthy.
wait_health() {
  local svcs="$1" timeout="${2:-150}" waited=0 interval=3
  LAST_HEALTH_STATUS=""
  while :; do
    local pending=0 line="" s c st
    for s in $svcs; do
      c="$(cid "$s")"
      if [ -z "$c" ]; then line="$line $s=absent"; pending=1; continue; fi
      st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null)"
      line="$line $s=$st"
      case "$st" in
        healthy)   ;;
        unhealthy) LAST_HEALTH_STATUS="$line"; return 2 ;;
        *)         pending=1 ;;   # starting / created / none (no healthcheck) / absent
      esac
    done
    if [ "$pending" -eq 0 ]; then LAST_HEALTH_STATUS="$line"; return 0; fi
    if [ "$waited" -ge "$timeout" ]; then LAST_HEALTH_STATUS="$line"; return 1; fi
    sleep "$interval"; waited=$((waited + interval))
  done
}

# Datastore client helpers (reuse the same images as the stack — already pulled).
# Each runs on the `data` network and returns the tool's stdout+stderr and exit code.
redis_cli() { docker run --rm --network "$DATA_NET" redis:7 redis-cli -h redis -a "$REDIS_PASSWORD" --no-auth-warning "$@" 2>&1; }

pg_role_connect() {  # $1 user  $2 password  $3 database  -> `SELECT 1` over TCP from `data`
  docker run --rm --network "$DATA_NET" -e PGPASSWORD="$2" postgres:16 \
    psql -h postgres -U "$1" -d "$3" -tAc 'SELECT 1' 2>&1
}

# App user against the analytics db; tries authSource=<db> then admin, records which.
mongo_app_eval() {  # $1 = js expression -> stdout, exit code
  local js="$1" out rc out2 rc2
  out="$(docker run --rm --network "$DATA_NET" mongo:7 mongosh --quiet \
        "mongodb://$MONGO_APP_USER:$MONGO_APP_PW@mongo:27017/$MONGO_DB" --eval "$js" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then MONGO_APP_AUTHSRC="$MONGO_DB"; printf '%s' "$out"; return 0; fi
  out2="$(docker run --rm --network "$DATA_NET" mongo:7 mongosh --quiet \
        "mongodb://$MONGO_APP_USER:$MONGO_APP_PW@mongo:27017/$MONGO_DB?authSource=admin" --eval "$js" 2>&1)"; rc2=$?
  if [ $rc2 -eq 0 ]; then MONGO_APP_AUTHSRC="admin"; printf '%s' "$out2"; return 0; fi
  printf '%s' "$out"; return $rc
}

# ==================================================================================
# STATIC CHECKS (no daemon required — docker CLI only, for `docker compose config`)
# ==================================================================================

# Check 1 (static) — none of the three datastores host-publishes a port.
# Proves DoD "none host-published" (static half; runtime health is Check 5).
check_no_publish() {
  section "Check 1 (static) — datastores host-publish no port (DoD: none host-published)"
  build_config; local rc=$?
  [ $rc -eq 3 ] && { skip "docker CLI absent — cannot resolve ports"; return; }
  if [ $rc -ne 0 ]; then fail "docker compose config did not parse — cannot check ports:"; printf '%s\n' "$LAST_CONFIG_ERR" >&2; return; fi
  [ -z "$PYTHON" ] && { skip "python not available to parse resolved config"; return; }
  if "$PYTHON" - "$CONFIG_JSON_FILE" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
services = cfg.get("services") or {}
bad = False
for name in ("postgres", "redis", "mongo"):
    svc = services.get(name)
    if svc is None:
        print(f"  datastore '{name}' is not defined as a service"); bad = True; continue
    ports = svc.get("ports") or []
    if ports:
        pub = [p.get("published") for p in ports if isinstance(p, dict)]
        print(f"  datastore '{name}' declares a host port mapping (must not publish): {ports}")
        bad = True
    else:
        print(f"  {name}: no host ports (correct)")
sys.exit(1 if bad else 0)
PY
  then pass "postgres, redis, mongo host-publish nothing"
  else fail "a datastore host-publishes a port — violates 'none host-published'"
  fi
}

# Check 2 (static) — connection-string contracts + every new role/auth var are
# documented in .env.example, MONGO_DB is `analytics`, and each URL encodes its own
# database (POSTGRES_URL->balance not keycloak; KC_DB_URL->keycloak; MONGO_URL->analytics).
# Proves the spec's Contracts section + supports the DoD's database-per-service intent.
check_contracts() {
  section "Check 2 (static) — env contracts documented & internally consistent (spec Contracts)"
  [ -f "$ENV_EXAMPLE" ] || { fail ".env.example not found — no contracts documented"; return; }
  [ -z "$PYTHON" ] && { skip "python not available to parse .env.example"; return; }
  if "$PYTHON" - "$ENV_EXAMPLE" <<'PY'
import re, sys
path = sys.argv[1]
raw = {}
for line in open(path, encoding='utf-8'):
    m = re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$', line.rstrip('\n'))
    if not m: continue
    v = m.group(2).strip()
    if len(v) >= 2 and ((v[0] == v[-1] == '"') or (v[0] == v[-1] == "'")):
        v = v[1:-1]
    raw[m.group(1)] = v

_pat = re.compile(r'\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}')
def expand(val, seen=()):
    def repl(mo):
        name, default = mo.group(1), mo.group(2)
        if name in seen: return ''
        if name in raw:  return expand(raw[name], seen + (name,))
        return default or ''
    prev = None
    while prev != val:
        prev = val; val = _pat.sub(repl, val)
    return val

required = [
    "POSTGRES_USER", "POSTGRES_PASSWORD",
    "POSTGRES_BALANCE_USER", "POSTGRES_BALANCE_PASSWORD",
    "POSTGRES_KEYCLOAK_USER", "POSTGRES_KEYCLOAK_PASSWORD",
    "REDIS_PASSWORD",
    "MONGO_INITDB_ROOT_USERNAME", "MONGO_INITDB_ROOT_PASSWORD",
    "MONGO_APP_USER", "MONGO_APP_PASSWORD", "MONGO_DB",
    "POSTGRES_URL", "KC_DB_URL", "REDIS_URL", "MONGO_URL",
]
errors = []
missing = [k for k in required if k not in raw]
if missing:
    errors.append("undocumented required var(s): " + ", ".join(missing))

bdb = raw.get("POSTGRES_DB", "balance")
adb = raw.get("MONGO_DB", "")
if "MONGO_DB" in raw and adb != "analytics":
    errors.append(f"MONGO_DB is '{adb}', expected 'analytics' (spec: analytics read model)")

def has_seg(url, name):   # /name at end or before ? — a real path segment
    return re.search(r'/' + re.escape(name) + r'(\?|$)', url) is not None

if "POSTGRES_URL" in raw:
    pu = expand(raw["POSTGRES_URL"])
    if not has_seg(pu, bdb):
        errors.append(f"POSTGRES_URL does not target the balance db '/{bdb}': {pu}")
    if has_seg(pu, "keycloak"):
        errors.append(f"POSTGRES_URL targets the keycloak db — breaks database-per-service: {pu}")
if "KC_DB_URL" in raw:
    kc = expand(raw["KC_DB_URL"])
    if not has_seg(kc, "keycloak"):
        errors.append(f"KC_DB_URL does not target the keycloak db '/keycloak': {kc}")
if "REDIS_URL" in raw:
    ru = expand(raw["REDIS_URL"])
    if "redis" not in ru:
        errors.append(f"REDIS_URL does not reference the 'redis' host: {ru}")
if "MONGO_URL" in raw:
    mu = expand(raw["MONGO_URL"])
    if "mongo" not in mu:
        errors.append(f"MONGO_URL does not reference the 'mongo' host: {mu}")
    if adb and not has_seg(mu, adb):
        errors.append(f"MONGO_URL does not target the '{adb}' db: {mu}")

for e in errors:
    print("  " + e)
if not errors:
    print("  all contract vars documented; URLs encode their own database")
sys.exit(1 if errors else 0)
PY
  then pass ".env.example documents every contract var; connection strings are internally consistent"
  else fail ".env.example is missing a contract var or a connection string targets the wrong database"
  fi
}

# Check 3 (static) — every required ${VAR} referenced in docker-compose.yml is
# documented in .env.example (extends macro Check 5 to the Step-1 additions).
check_compose_env_complete() {
  section "Check 3 (static) — every \${VAR} referenced by compose is documented in .env.example"
  [ -f "$COMPOSE" ] || { fail "docker-compose.yml not found"; return; }
  [ -f "$ENV_EXAMPLE" ] || { fail ".env.example not found — no variables documented"; return; }
  [ -z "$PYTHON" ] && { skip "python not available to parse variable references"; return; }
  if "$PYTHON" - "$COMPOSE" "$ENV_EXAMPLE" <<'PY'
import re, sys
compose = open(sys.argv[1], encoding='utf-8').read()
env = open(sys.argv[2], encoding='utf-8').read()
compose = compose.replace("$$", "")  # drop escaped literal dollars ($$VAR is not a ref)

required, optional = set(), set()
for name, op in re.findall(r'\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-+?])?', compose):
    if op in (":-", "-", ":+", "+"):
        optional.add(name)
    else:                       # "", ":?", "?"  -> required
        required.add(name)
for name in re.findall(r'(?<![\w$])\$([A-Za-z_][A-Za-z0-9_]*)', compose):
    required.add(name)          # bare $VAR can carry no default

defined = set()
for line in env.splitlines():
    m = re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=', line)
    if m: defined.add(m.group(1))

req_missing = sorted(required - defined)
opt_missing = sorted((optional - required) - defined)
print(f"  referenced: {len(required | optional)} var(s); documented: {len(defined)}")
for v in opt_missing:
    print(f"  NOTE: '{v}' has an inline default and is not documented (optional)")
for v in req_missing:
    print(f"  MISSING (required): '{v}' referenced without a default but not documented")
sys.exit(1 if req_missing else 0)
PY
  then pass ".env.example documents every required variable referenced by the compose file"
  else fail ".env.example is missing a required variable (a fresh clone would fail to start)"
  fi
}

# Check 4 (static, no-secrets) — no committed secret literal. The placeholder secret
# VALUES from .env.example must not appear in any other tracked file (an init script
# that embeds them isn't env-driven), and infra init scripts must set passwords from
# env ($VAR), never a bare literal. A committed literal secret is a hard failure.
check_no_committed_secret() {
  section "Check 4 (static) — no hardcoded secret in infra/ or compose (CLAUDE.md no-secrets)"
  command -v git >/dev/null 2>&1 || { skip "git not installed — cannot scan tracked files"; return; }
  git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || { skip "not a git repository"; return; }
  [ -f "$ENV_EXAMPLE" ] || { skip ".env.example not found — no placeholder values to trace"; return; }

  local bad=0 key val hits
  # (a) placeholder secret values must not leak into any other tracked file.
  for key in POSTGRES_PASSWORD POSTGRES_BALANCE_PASSWORD POSTGRES_KEYCLOAK_PASSWORD \
             REDIS_PASSWORD MONGO_INITDB_ROOT_PASSWORD MONGO_APP_PASSWORD; do
    val="$(env_val "$key")"
    [ -n "$val" ] || continue
    [ "${#val}" -ge 4 ] || continue           # skip values too short to trace reliably
    # grep tracked files; exclude the template itself and this test suite.
    hits="$(git -C "$REPO_ROOT" grep -n -F -e "$val" -- . ':!.env.example' ':!tests/' 2>/dev/null)"
    if [ -n "$hits" ]; then
      fail "secret value of '$key' is hardcoded in a tracked file (must come from env):"
      printf '%s\n' "$hits" | sed 's/^/      /' >&2
      bad=1
    fi
  done

  # (b) literal scan of infra init scripts + the compose file: a credential-setting
  # line must use an env reference ($VAR / process.env), never a bare quoted literal.
  # Documentation files are excluded, and any line carrying an env reference is
  # treated as env-driven (so `PASSWORD :'var'`, `pwd: appPwd`, `process.env.X` pass).
  if [ -n "$PYTHON" ]; then
    [ -d "$INFRA_DIR" ] || info "no infra/ directory yet — literal scan covers the compose file only"
    if ! "$PYTHON" - "$INFRA_DIR" "$COMPOSE" <<'PY'
import os, re, sys
DOC_EXT = {'.md', '.markdown', '.txt', '.rst', '.adoc'}
# Genuine password-LITERAL shapes (quoted literal, or a requirepass/VAR= value).
patterns = [
    re.compile(r"PASSWORD\s+(['\"])(.*?)\1", re.I),                       # SQL:  PASSWORD 'literal'
    re.compile(r"\bpwd\s*:\s*(['\"])(.*?)\1", re.I),                      # mongo JS: pwd: "literal"
    re.compile(r"\brequirepass\s+(\S+)", re.I),                           # redis: requirepass token
    re.compile(r"\b[A-Za-z_]*PASSWORD\s*=\s*(['\"]?)([^'\"\s#]+)\1", re.I),  # VAR=literal
]
def env_ref(line):
    return ('$' in line) or ('process.env' in line) or ('%' in line)
def scan_file(path, rel):
    out = []
    try:
        text = open(path, encoding='utf-8', errors='replace').read()
    except OSError:
        return out
    for i, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if not s or s.startswith('#') or s.startswith('--') or s.startswith('//') or s.startswith('*'):
            continue
        if env_ref(line):     # any $VAR / process.env / %VAR% -> env-driven, not a literal
            continue
        for pat in patterns:
            if pat.search(line):
                out.append(f"{rel}:{i}: {s}")
                break
    return out
flagged = []
for arg in sys.argv[1:]:
    if os.path.isdir(arg):
        for dp, _d, files in os.walk(arg):
            for fn in files:
                if os.path.splitext(fn)[1].lower() in DOC_EXT:
                    continue
                p = os.path.join(dp, fn)
                flagged += scan_file(p, os.path.relpath(p, arg))
    elif os.path.isfile(arg):
        flagged += scan_file(arg, os.path.basename(arg))
for f in flagged:
    print("  " + f)
sys.exit(1 if flagged else 0)
PY
    then
      fail "a password is set to a bare literal in infra/ or compose (must use an env reference)"
      bad=1
    fi
  else
    info "python not available — literal scan (b) skipped; value-leak scan (a) still ran"
  fi

  [ "$bad" -eq 0 ] && pass "no placeholder secret value leaked into a tracked file; init scripts set passwords from env"
}

# ==================================================================================
# RUNTIME CHECKS (require Docker daemon)
# ==================================================================================

# Check 5 (runtime) — postgres, redis, mongo all reach `healthy`.
# Proves DoD "all three reach healthy" AND that Redis AUTH + the mongo/postgres init
# did not break the healthcheck (a broken auth/init flips the container unhealthy).
check_health() {
  section "Check 5 (runtime) — all three reach healthy (DoD; proves AUTH/init didn't break healthcheck)"
  wait_health "postgres redis mongo" 180; local rc=$?
  case $rc in
    0) pass "postgres, redis, mongo all reached 'healthy' (status:$LAST_HEALTH_STATUS )" ;;
    2) fail "a datastore reported UNHEALTHY (status:$LAST_HEALTH_STATUS ) — likely AUTH/init broke its healthcheck" ;;
    *) fail "datastores not all healthy within timeout (status:$LAST_HEALTH_STATUS ) — '=none' means no healthcheck" ;;
  esac
  return $rc
}

# Check 6 (runtime) — the `balance` and `keycloak` databases both exist.
# Proves DoD "balance and keycloak databases exist".
check_databases() {
  section "Check 6 (runtime) — 'balance' and 'keycloak' databases exist (DoD)"
  if [ -z "$POSTGRES_USER" ] || [ -z "$POSTGRES_PASSWORD" ]; then
    fail "POSTGRES_USER/PASSWORD not documented in .env.example — cannot query databases (see Check 2)"; return
  fi
  local c; c="$(cid postgres)"
  [ -n "$c" ] || { fail "postgres container not found under project '$PROJECT'"; return; }
  local bad=0 db out
  for db in "$BALANCE_DB" "$KEYCLOAK_DB"; do
    out="$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$c" \
          psql -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" -U "$POSTGRES_USER" -d postgres 2>&1)"
    if [ "$(printf '%s' "$out" | tr -d '[:space:]')" = "1" ]; then
      info "database '$db' present"
    else
      fail "database '$db' does NOT exist (psql: $out)"; bad=1
    fi
  done
  [ $bad -eq 0 ] && pass "both 'balance' and 'keycloak' databases exist"
}

# Check 7 (runtime, SAFETY-CRITICAL) — role/database privilege split.
#   positive: balance role connects to `balance` and runs SELECT 1
#   negative: balance role is DENIED connecting to `keycloak`  <- the whole point
#   positive: keycloak role connects to `keycloak`
#   negative: keycloak role is DENIED connecting to `balance`  (symmetric leak guard)
# Proves DoD "app role can connect to balance and CANNOT connect to keycloak" +
# "database-per-service enforced by role privileges".
check_privileges() {
  section "Check 7 (runtime, safety-critical) — role privilege split (DoD database-per-service)"
  if [ -z "$BAL_USER" ] || [ -z "$BAL_PW" ] || [ -z "$KC_USER" ] || [ -z "$KC_PW" ]; then
    fail "balance/keycloak role vars not documented in .env.example — cannot test the privilege split (see Check 2)"; return
  fi
  [ -n "$DATA_NET" ] || { fail "'data' network not resolved — cannot run role connections"; return; }
  local bad=0 out rc

  # positive: balance -> balance
  out="$(pg_role_connect "$BAL_USER" "$BAL_PW" "$BALANCE_DB")"; rc=$?
  if [ $rc -eq 0 ] && [ "$(printf '%s' "$out" | tr -d '[:space:]')" = "1" ]; then
    info "balance role CAN connect to '$BALANCE_DB' (positive control ok)"
  else
    fail "balance role could NOT connect to its own db '$BALANCE_DB' (rc=$rc, out: $out)"; bad=1
  fi

  # negative: balance -> keycloak  (must be denied). Positive control above proves
  # the creds are valid, so a denial here is a privilege denial, not a bad password.
  out="$(pg_role_connect "$BAL_USER" "$BAL_PW" "$KEYCLOAK_DB")"; rc=$?
  if [ $rc -eq 0 ]; then
    fail "SAFETY VIOLATION: balance role CAN connect to '$KEYCLOAK_DB' — database-per-service breached"; bad=1
  elif printf '%s' "$out" | grep -qiE 'permission denied|not permitted|no pg_hba|not allowed'; then
    info "balance role is DENIED connecting to '$KEYCLOAK_DB' (negative control ok)"
  else
    fail "balance->keycloak failed, but not with a privilege error (rc=$rc, out: $out) — unexpected"; bad=1
  fi

  # positive: keycloak -> keycloak
  out="$(pg_role_connect "$KC_USER" "$KC_PW" "$KEYCLOAK_DB")"; rc=$?
  if [ $rc -eq 0 ] && [ "$(printf '%s' "$out" | tr -d '[:space:]')" = "1" ]; then
    info "keycloak role CAN connect to '$KEYCLOAK_DB' (positive control ok)"
  else
    fail "keycloak role could NOT connect to its own db '$KEYCLOAK_DB' (rc=$rc, out: $out)"; bad=1
  fi

  # negative: keycloak -> balance (must be denied; guards the reverse leak)
  out="$(pg_role_connect "$KC_USER" "$KC_PW" "$BALANCE_DB")"; rc=$?
  if [ $rc -eq 0 ]; then
    fail "SAFETY VIOLATION: keycloak role CAN connect to '$BALANCE_DB' — reverse database-per-service leak"; bad=1
  elif printf '%s' "$out" | grep -qiE 'permission denied|not permitted|no pg_hba|not allowed'; then
    info "keycloak role is DENIED connecting to '$BALANCE_DB' (negative control ok)"
  else
    fail "keycloak->balance failed, but not with a privilege error (rc=$rc, out: $out) — unexpected"; bad=1
  fi

  [ $bad -eq 0 ] && pass "privilege split holds: each role reaches ONLY its own database"
}

# Check 8 (runtime) — Redis & Mongo AUTH is enforced; authenticated ping/connect
# succeed on `data`. Proves DoD "redis-cli ping and Mongo ping succeed from within
# data" AND that auth is real (unauth is denied — otherwise 'auth enabled' is unproven).
check_auth_enforced() {
  section "Check 8 (runtime) — Redis/Mongo AUTH enforced; authed ping succeeds on 'data' (DoD)"
  [ -n "$DATA_NET" ] || { fail "'data' network not resolved — cannot run auth checks"; return; }
  local bad=0

  # ---- Redis ----
  if [ -z "$REDIS_PASSWORD" ]; then
    fail "REDIS_PASSWORD not documented in .env.example — cannot verify Redis AUTH (see Check 2)"; bad=1
  else
    local authed unauth
    authed="$(redis_cli ping)"
    if [ "$(printf '%s' "$authed" | tr -d '[:space:]')" = "PONG" ]; then
      info "redis: authenticated ping -> PONG"
    else
      fail "redis: authenticated ping did NOT return PONG (got: $authed)"; bad=1
    fi
    unauth="$(docker run --rm --network "$DATA_NET" redis:7 redis-cli -h redis ping 2>&1)"
    if printf '%s' "$unauth" | grep -qi 'NOAUTH'; then
      info "redis: unauthenticated ping -> denied (NOAUTH) — AUTH enforced"
    elif [ "$(printf '%s' "$unauth" | tr -d '[:space:]')" = "PONG" ]; then
      fail "redis: UNAUTHENTICATED ping returned PONG — AUTH is NOT enforced"; bad=1
    else
      fail "redis: unauthenticated ping gave an unexpected result (got: $unauth)"; bad=1
    fi
  fi

  # ---- Mongo (root auth works; unauth privileged op denied) ----
  if [ -z "$MONGO_ROOT_USER" ] || [ -z "$MONGO_ROOT_PW" ]; then
    fail "MONGO_INITDB_ROOT_USERNAME/PASSWORD not documented — cannot verify Mongo AUTH (see Check 2)"; bad=1
  else
    local mping rc munauth urc
    mping="$(docker run --rm --network "$DATA_NET" mongo:7 mongosh --quiet \
            "mongodb://$MONGO_ROOT_USER:$MONGO_ROOT_PW@mongo:27017/admin" --eval "db.adminCommand('ping').ok" 2>&1)"; rc=$?
    if [ $rc -eq 0 ] && printf '%s' "$mping" | grep -q '1'; then
      info "mongo: authenticated ping ok"
    else
      fail "mongo: authenticated ping failed (rc=$rc, got: $mping)"; bad=1
    fi
    munauth="$(docker run --rm --network "$DATA_NET" mongo:7 mongosh --quiet \
             "mongodb://mongo:27017/admin" --eval "db.adminCommand({listDatabases:1}).databases.length" 2>&1)"; urc=$?
    if [ $urc -ne 0 ] && printf '%s' "$munauth" | grep -qiE 'auth|not authorized|unauthorized|requires'; then
      info "mongo: unauthenticated listDatabases -> denied — AUTH enforced"
    else
      fail "mongo: unauthenticated listDatabases was NOT denied (rc=$urc, out: $munauth) — AUTH not enforced"; bad=1
    fi
  fi

  # ---- Mongo app user can authenticate to `analytics` (proves app user + db exist) ----
  if [ -z "$MONGO_APP_USER" ] || [ -z "$MONGO_APP_PW" ]; then
    fail "MONGO_APP_USER/PASSWORD not documented — cannot verify the analytics app user (see Check 2)"; bad=1
  else
    local app rc
    app="$(mongo_app_eval "db.runCommand({ping:1}).ok")"; rc=$?
    if [ $rc -eq 0 ] && printf '%s' "$app" | grep -q '1'; then
      info "mongo: app user authenticated to '$MONGO_DB' (readWrite)"
    else
      fail "mongo: app user could NOT authenticate to '$MONGO_DB' (rc=$rc, got: $app)"; bad=1
    fi
  fi

  [ $bad -eq 0 ] && pass "Redis & Mongo require auth; authed ping/connect succeed on 'data'; unauth is denied"
}

# Check 9 (runtime, SHARPEST) — data persists across `compose down && up` (no -v),
# and Redis AOF is ON (the Resolved decision: a wiped stream would drop in-flight
# outbox events). Writes a marker into each store, restarts WITHOUT -v, and asserts
# all three survived. Proves DoD "volumes persist data across down && up".
check_persistence() {
  section "Check 9 (runtime) — volumes persist across down && up (no -v); Redis AOF ON (DoD + Resolved)"
  [ -n "$DATA_NET" ] || { fail "'data' network not resolved — cannot run persistence checks"; return; }

  # 9a — Redis AOF (appendonly) must be ON per the Resolved decision.
  if [ -n "$REDIS_PASSWORD" ]; then
    local aof; aof="$(redis_cli config get appendonly)"
    if printf '%s' "$aof" | grep -qi 'yes'; then
      info "redis appendonly (AOF) = yes (Resolved decision holds)"
    else
      fail "redis appendonly is NOT 'yes' (got: $aof) — Resolved AOF decision unmet; the outbox stream could be lost"
    fi
  else
    fail "REDIS_PASSWORD not documented — cannot verify AOF or seed the redis marker (see Check 2)"
    return
  fi

  # --- seed markers -------------------------------------------------------------
  local w_ok=1 c; c="$(cid postgres)"
  if ! docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$c" \
        psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$BALANCE_DB" -c \
        "CREATE TABLE IF NOT EXISTS scfin_persist_probe(k text primary key, v text); INSERT INTO scfin_persist_probe(k,v) VALUES('marker','survived') ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v;" >/dev/null 2>&1; then
    fail "could not seed postgres marker into '$BALANCE_DB'"; w_ok=0
  fi
  if ! printf '%s' "$(redis_cli set scfin:persist:probe survived)" | grep -qi 'OK'; then
    fail "could not seed redis marker"; w_ok=0
  fi
  if ! mongo_app_eval "db.scfin_persist_probe.insertOne({k:'marker',v:'survived'})" >/dev/null 2>&1; then
    fail "could not seed mongo marker into '$MONGO_DB' (app user)"; w_ok=0
  fi
  if [ "$w_ok" -ne 1 ]; then fail "Check 9 — could not seed all markers; persistence left unproven"; return; fi
  info "markers written to postgres, redis, mongo"

  # --- restart WITHOUT -v (containers removed, named volumes kept) --------------
  info "docker compose down (NO -v), then up — the volumes must survive"
  compose_down_keepv >/dev/null 2>&1
  local err; err="$(mktemp)"
  if ! compose_up >/dev/null 2>"$err"; then
    fail "Check 9 — re-'up' after down failed:"; cat "$err" >&2; rm -f "$err"; return
  fi
  rm -f "$err"
  DATA_NET="$(compose_net_name data)"
  wait_health "postgres redis mongo" 180; local rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "Check 9 — datastores did not return healthy after restart (status:$LAST_HEALTH_STATUS )"; return
  fi

  # --- verify every marker survived --------------------------------------------
  local ok=1 pv rv mv c2; c2="$(cid postgres)"
  pv="$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$c2" \
        psql -tAc "SELECT v FROM scfin_persist_probe WHERE k='marker'" -U "$POSTGRES_USER" -d "$BALANCE_DB" 2>/dev/null | tr -d '[:space:]')"
  if [ "$pv" = "survived" ]; then info "postgres marker survived"; else fail "postgres marker LOST across restart (got '$pv') — pg-data did not persist"; ok=0; fi

  rv="$(redis_cli get scfin:persist:probe | tr -d '[:space:]')"
  if [ "$rv" = "survived" ]; then info "redis marker survived (AOF held the key)"; else fail "redis key LOST across restart (got '$rv') — redis-data/AOF did not persist"; ok=0; fi

  mv="$(mongo_app_eval "db.scfin_persist_probe.findOne({k:'marker'}).v" 2>/dev/null)"
  case "$(printf '%s' "$mv" | tr -d '[:space:]')" in
    *survived*) info "mongo marker survived" ;;
    *)          fail "mongo document LOST across restart (got '$mv') — mongo-data did not persist"; ok=0 ;;
  esac

  [ "$ok" -eq 1 ] && pass "all three markers survived 'down (no -v) && up' — volumes persist (Redis AOF holds the key)"
}

# ----------------------------------------------------------------------------------
# Phase runners
# ----------------------------------------------------------------------------------
run_static() {
  section "STATIC CHECKS (no Docker daemon required)"
  check_no_publish
  check_contracts
  check_compose_env_complete
  check_no_committed_secret
}

run_runtime() {
  section "RUNTIME CHECKS (require Docker daemon)"
  if ! command -v docker >/dev/null 2>&1; then skip "docker CLI not installed — runtime checks 5-9 skipped"; return; fi
  if ! docker info >/dev/null 2>&1; then skip "Docker daemon not reachable — runtime checks 5-9 skipped"; return; fi
  [ -f "$COMPOSE" ]     || { fail "docker-compose.yml not found — cannot run runtime checks"; return; }
  [ -f "$ENV_EXAMPLE" ] || { fail ".env.example not found — cannot resolve runtime env"; return; }

  load_env_values

  RUNTIME_ENVFILE="$(mktemp)"; cp "$ENV_EXAMPLE" "$RUNTIME_ENVFILE"
  # Fresh slate for THIS isolated project (never touches another stack — the
  # datastores set no container_name, so the project name fully namespaces them).
  compose_down_v >/dev/null 2>&1

  info "bringing up postgres, redis, mongo under project '$PROJECT'"
  local err; err="$(mktemp)"
  if ! compose_up >/dev/null 2>"$err"; then
    fail "Check 5 — 'docker compose up' failed:"; cat "$err" >&2; rm -f "$err"
    skip "Checks 6-9 skipped (stack failed to start)"
    compose_down_v >/dev/null 2>&1
    return
  fi
  rm -f "$err"

  DATA_NET="$(compose_net_name data)"
  if [ -z "$DATA_NET" ]; then
    fail "could not resolve the 'data' network for project '$PROJECT'"
    skip "Checks 6-9 skipped (no data network)"
    compose_down_v >/dev/null 2>&1
    return
  fi

  check_health; local h=$?
  if [ "$h" -ne 0 ]; then
    skip "Checks 6-9 skipped — datastores not healthy (see Check 5)"
    compose_down_v >/dev/null 2>&1
    return
  fi

  check_databases
  check_privileges
  check_auth_enforced
  check_persistence

  info "final teardown of project '$PROJECT' (with -v)"
  compose_down_v >/dev/null 2>&1
}

# Idempotent cleanup of everything this suite may create; safe on any exit.
global_cleanup() {
  [ -n "${CONFIG_JSON_FILE:-}" ] && rm -f "$CONFIG_JSON_FILE" 2>/dev/null
  [ -n "${RUNTIME_ENVFILE:-}" ]  && rm -f "$RUNTIME_ENVFILE" 2>/dev/null
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && [ -f "$COMPOSE" ]; then
    docker compose -p "$PROJECT" --project-directory "$REPO_ROOT" -f "$COMPOSE" down -v --remove-orphans >/dev/null 2>&1
  fi
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
