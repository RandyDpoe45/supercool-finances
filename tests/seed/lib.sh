#!/usr/bin/env bash
# lib.sh — shared helpers and all verification checks for the SEED DATA step of
# spec 08 (step 8-B). Sourced by run.sh; defines functions only, never exits.
#
# Checks are written FROM the spec (specs/08-build-and-serve.md — the "Seed data"
# section, its "Demo dataset" contract, the "Sub alignment" developer ruling, and the
# Definition of Done "Seed data is present…" + "Re-running up is idempotent"), NOT from
# the implementor's tools/seed code. Each asserts an INTENDED invariant so it can fail
# on a real defect. DB creds/coordinates come from .env.example; the demo dataset VALUES
# are the spec contract and are pinned here (they ARE the source of truth both the seed
# code and these tests follow).
#
# THE LOAD-BEARING LINK (spec "Sub alignment"): customer.id IS the Keycloak sub and
# account.owner_id FKs to it, so Customer A's seeded id MUST equal the `demo-customer`
# user's pinned id in realm-export.json — otherwise a real Keycloak login will never map
# to the seeded customer. A hardcoded-but-mismatched id fails Check 3 (static, vs the
# pinned contract) AND R3 (runtime, vs the actually-inserted row).
#
# SCOPE: the seed tool + its dataset + idempotency + compose `seed`-profile gating only.
# The SPA serving plane, Kong auth, and the e2e transfer flow are OTHER spec-08 slices
# (tests/build-serve, tests/transport) and are not re-tested here.

# ----------------------------------------------------------------------------------
# Environment / globals
# ----------------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$REPO_ROOT/docker-compose.yml"
ENV_EXAMPLE="$REPO_ROOT/.env.example"
REALM_EXPORT="$REPO_ROOT/tools/keycloak/realm-export.json"

# Isolated compose project — a name that cannot collide with any real stack, so a
# teardown with -v can only ever remove THIS suite's containers/volumes/networks. The
# spine's datastores set no container_name, so the project name fully namespaces them;
# nothing this suite brings up is host-published, so there are no port collisions with a
# concurrently-running real stack.
PROJECT="scfin-seed-test"
SEED_PROFILE="seed"

# --- The demo dataset contract (spec 08 "Demo dataset"). These ARE the spec. ---
PINNED_CUSTOMER_ID="11111111-1111-4111-8111-111111111111"   # demo-customer sub (realm-export)
PINNED_ADMIN_ID="22222222-2222-4222-8222-222222222222"      # demo-admin sub (realm-export)
# Customer A — the login (demo-customer); its id IS the pinned sub above.
A_EMAIL="demo-customer@example.test"; A_NAME="Demo Customer"; A_PHONE="5510000001"
A_ACCT="1000000001"; A_BAL="100000000"                       # 1,000,000.00 MXN
# Customer B — transfer destination, NO Keycloak login; synthetic id.
B_ID="b0000000-0000-4000-8000-000000000002"
B_EMAIL="maria.gonzalez@example.test"; B_NAME="Maria Gonzalez"; B_PHONE="5520000002"
B_ACCT="1000000002"; B_BAL="50000000"                        # 500,000.00 MXN
# System constants the seed must NOT touch (seeded by boot migrations).
EXPECT_SYSTEM_ACCOUNTS=2   # clearing:rail-outbound + clearing:rail-inbound
EXPECT_GLOBAL_LIMITS=1     # one global baseline user_limits row

# Discovered / cached.
SEED_SVC=""                 # the service gated behind the `seed` profile (discovered)
RUNTIME_ENVFILE=""          # temp copy of .env.example for `up`/`run`; cleaned on exit
DC_FALLBACK_ENV=""
LAST_HEALTH_STATUS=""

# DB creds/coordinates loaded from .env.example at runtime.
POSTGRES_USER=""; POSTGRES_PASSWORD=""; BALANCE_DB=""
BALANCE_ROLE_USER=""; SUPERUSER_PW=""

# Runtime snapshots (captured while the stack is up, asserted after teardown).
BASE_MXN=""; BASE_SYS=""; BASE_LIM=""; BASE_CUST=""; BASE_CACCT=""
SEED1_RC=""; SEED1_ERRMSG=""; SEED1_OK=0
A1_ROW=""; A1_ACCT_COUNT=""; A1_ID=""; A1_OWNER=""; A1_UPDATED=""
B1_ROW=""; B1_ACCT_COUNT=""
AFTER1_CUR=""; AFTER1_SYS=""; AFTER1_LIM=""; AFTER1_LIM_CUST=""; AFTER1_CUST=""; AFTER1_CACCT=""
SEED2_RC=""; SEED2_ERRMSG=""
AFTER2_CUST=""; AFTER2_CACCT=""; AFTER2_SYS=""; AFTER2_CUR=""; AFTER2_LIM=""; A2_UPDATED=""

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

is_env_failure() {
  printf '%s' "$1" | grep -qiE 'network|timeout|temporary failure|could not resolve|lookup|tls|dial tcp|connection refused|no such host|pull access|manifest unknown|i/o timeout|EAI_AGAIN|registry'
}

# ----------------------------------------------------------------------------------
# .env.example value reader (pure bash — runtime checks must not depend on python).
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
  POSTGRES_USER="$(env_val POSTGRES_USER)"
  POSTGRES_PASSWORD="$(env_val POSTGRES_PASSWORD)"
  SUPERUSER_PW="$POSTGRES_PASSWORD"
  BALANCE_DB="$(env_val POSTGRES_DB)"; [ -n "$BALANCE_DB" ] || BALANCE_DB="balance"
  BALANCE_ROLE_USER="$(env_val POSTGRES_BALANCE_USER)"
}

# ----------------------------------------------------------------------------------
# Resolved-config helpers — `docker compose config` (docker CLI, NOT the daemon). In
# Compose v2 a profiled service is EXCLUDED from the default config and only appears
# once its profile is active, so the gating proof is: absent by default, present under
# `--profile seed`.
#   render_config [profile] -> prints a temp JSON file path (caller rm's it); rc 0/1/3.
# ----------------------------------------------------------------------------------
render_config() {
  command -v docker >/dev/null 2>&1 || return 3
  [ -f "$COMPOSE" ] || return 1
  local prof="${1:-}" tmpenv out err rc
  tmpenv="$(mktemp)"; out="$(mktemp)"; err="$(mktemp)"
  if [ -f "$ENV_EXAMPLE" ]; then cp "$ENV_EXAMPLE" "$tmpenv"; else : > "$tmpenv"; fi
  if [ -n "$prof" ]; then
    docker compose --project-directory "$REPO_ROOT" --env-file "$tmpenv" --profile "$prof" \
      -f "$COMPOSE" config --format json >"$out" 2>"$err"; rc=$?
  else
    docker compose --project-directory "$REPO_ROOT" --env-file "$tmpenv" \
      -f "$COMPOSE" config --format json >"$out" 2>"$err"; rc=$?
  fi
  rm -f "$tmpenv" "$err"
  if [ "$rc" -eq 0 ]; then printf '%s' "$out"; return 0; else rm -f "$out"; return 1; fi
}

# Discover the service gated behind the `seed` profile: present under --profile seed,
# absent by default, with 'seed' in its profiles. Sets SEED_SVC; returns 0 if found.
discover_seed_service() {
  command -v docker >/dev/null 2>&1 || return 1
  [ -z "$PYTHON" ] && return 1
  local defj profj
  defj="$(render_config "")"            || return 1
  profj="$(render_config "$SEED_PROFILE")" || { rm -f "$defj"; return 1; }
  SEED_SVC="$("$PYTHON" - "$defj" "$profj" "$SEED_PROFILE" <<'PY'
import json, sys
defj = json.load(open(sys.argv[1], encoding='utf-8')).get('services', {})
profj = json.load(open(sys.argv[2], encoding='utf-8')).get('services', {})
prof = sys.argv[3]
cands = [n for n, s in profj.items() if n not in defj and prof in (s.get('profiles') or [])]
print(cands[0] if cands else '')
PY
)"
  rm -f "$defj" "$profj" 2>/dev/null
  [ -n "$SEED_SVC" ]
}

# ----------------------------------------------------------------------------------
# realm-export.json reader — the pinned id a user carries (empty if none). Pure
# python+file; used by both the static and the runtime sub-alignment checks.
# ----------------------------------------------------------------------------------
realm_user_field() {  # $1 = username  $2 = field (id|email)
  [ -n "$PYTHON" ] || { printf ''; return 1; }
  [ -f "$REALM_EXPORT" ] || { printf ''; return 1; }
  "$PYTHON" - "$REALM_EXPORT" "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
want, field = sys.argv[2], sys.argv[3]
for u in d.get('users', []):
    if u.get('username') == want:
        print(u.get(field) or '')
        break
PY
}

# ----------------------------------------------------------------------------------
# Compose lifecycle helpers (isolated project; relative mounts resolve against
# --project-directory = repo root). `dc` always supplies an --env-file so the spine's
# ${KEYCLOAK_PORT} etc. interpolate on every subcommand (ps/down/run).
# ----------------------------------------------------------------------------------
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
cid() { dc ps -q "$1" 2>/dev/null | head -1; }
teardown() { dc down -v --remove-orphans >/dev/null 2>&1; }

# wait_health "<svc ...>" <timeout_s> -> 0 healthy, 1 timeout, 2 unhealthy.
wait_health() {
  local svcs="$1" timeout="${2:-180}" waited=0 interval=4
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
        *)         pending=1 ;;
      esac
    done
    if [ "$pending" -eq 0 ]; then LAST_HEALTH_STATUS="$line"; return 0; fi
    if [ "$waited" -ge "$timeout" ]; then LAST_HEALTH_STATUS="$line"; return 1; fi
    sleep "$interval"; waited=$((waited + interval))
  done
}

# psql helpers — superuser (bypasses the least-priv CONNECT split) against `balance`.
pg_scalar() {  # $1 = sql -> single trimmed value
  local c; c="$(cid postgres)"
  [ -n "$c" ] || { printf ''; return 1; }
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$c" \
    psql -tAqc "$1" -U "$POSTGRES_USER" -d "$BALANCE_DB" 2>/dev/null | tr -d '\r' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | head -1
}
pg_row() {     # $1 = sql -> pipe-separated fields of the FIRST row (CR-stripped)
  local c; c="$(cid postgres)"
  [ -n "$c" ] || { printf ''; return 1; }
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$c" \
    psql -tAqF '|' -c "$1" -U "$POSTGRES_USER" -d "$BALANCE_DB" 2>/dev/null | tr -d '\r' | head -1
}

# Run the seed once. $1 = errfile, $2 = build|nobuild. Returns the container exit code.
seed_run() {
  local errf="$1" mode="$2" rc
  if [ "$mode" = "build" ]; then
    dc --profile "$SEED_PROFILE" run --rm -T --build "$SEED_SVC" >/dev/null 2>"$errf"; rc=$?
  else
    dc --profile "$SEED_PROFILE" run --rm -T "$SEED_SVC" >/dev/null 2>"$errf"; rc=$?
  fi
  return $rc
}

# ==================================================================================
# STATIC CHECKS (no daemon — docker CLI `compose config` + python + file reads)
# ==================================================================================

# Check 1 (static) — the seed step is a compose `seed`-profile one-shot: ABSENT from the
# default `up` graph, PRESENT under `--profile seed`, and host-publishes nothing. (spec
# 08: "a one-shot service under a compose `seed` profile … run explicitly (`docker
# compose --profile seed up`) so the default `up` graph carries no … seed container".)
# FAILs until the implementor wires a properly-gated seed service (step-not-done signal).
check_profile_gating() {
  section "Check 1 (static) — seed is a \`$SEED_PROFILE\`-profile one-shot: absent from default \`up\`, present under --profile $SEED_PROFILE"
  [ -f "$COMPOSE" ] || { fail "docker-compose.yml not found at $COMPOSE"; return; }
  command -v docker >/dev/null 2>&1 || { skip "docker CLI not installed — cannot run 'docker compose config'"; return; }
  [ -z "$PYTHON" ] && { skip "python not available to parse resolved config"; return; }
  local defj profj
  defj="$(render_config "")"            || { fail "default 'docker compose config' did not parse"; return; }
  profj="$(render_config "$SEED_PROFILE")" || { fail "'docker compose --profile $SEED_PROFILE config' did not parse"; rm -f "$defj"; return; }
  "$PYTHON" - "$defj" "$profj" "$SEED_PROFILE" <<'PY'
import json, sys
defj = json.load(open(sys.argv[1], encoding='utf-8')).get('services', {})
profj = json.load(open(sys.argv[2], encoding='utf-8')).get('services', {})
prof = sys.argv[3]
problems = []
gated = [n for n, s in profj.items() if prof in (s.get('profiles') or [])]
if not gated:
    problems.append(f"no service is gated behind the '{prof}' profile — the seed step is not wired (step not done)")
else:
    print(f"  service(s) gated behind '{prof}': {gated}")
leaked = [n for n in gated if n in defj]
if leaked:
    problems.append(f"seed service(s) {leaked} appear in the DEFAULT up graph — they must be profile-gated ('{prof}'), so a plain `up` never runs them")
else:
    if gated:
        print("  none of the gated seed service(s) are in the default up graph (a plain `up` won't run them)")
for n in gated:
    if profj.get(n, {}).get('ports'):
        problems.append(f"seed service '{n}' host-publishes {profj[n]['ports']} — a one-shot tool must publish nothing")
for p in problems:
    print(f"  -> {p}")
sys.exit(1 if problems else 0)
PY
  local rc=$?
  rm -f "$defj" "$profj" 2>/dev/null
  if [ "$rc" -eq 0 ]; then
    pass "seed is a \`$SEED_PROFILE\`-profile one-shot: excluded from the default up graph, selectable via --profile $SEED_PROFILE, host-publishes nothing"
  else
    fail "seed profile gating is wrong or the seed service is missing (see -> lines) — the step is not done or the seed would run on a plain \`up\`"
  fi
}

# Check 2 (static) — the seed reaches Postgres with the SAME discrete creds as the
# service, i.e. the least-privilege balance role — NEVER the bootstrap superuser.
# (spec 08: "reaching Postgres with the same discrete creds as the service".) The hard
# failure is a seed running as the superuser (least-privilege violation); using the
# balance role is the pass. Unresolvable wiring is a NOTE, never a false fail.
check_seed_creds() {
  section "Check 2 (static) — seed uses the balance role's discrete creds, NOT the bootstrap superuser"
  command -v docker >/dev/null 2>&1 || { skip "docker CLI not installed — cannot resolve seed env"; return; }
  [ -z "$PYTHON" ] && { skip "python not available to parse resolved config"; return; }
  if ! discover_seed_service; then
    skip "no \`$SEED_PROFILE\`-profile seed service defined yet (see Check 1) — cannot inspect its creds"; return
  fi
  load_env_values
  if [ -z "$BALANCE_ROLE_USER" ] || [ -z "$SUPERUSER_PW" ]; then
    skip "balance role / superuser values not documented in .env.example — cannot evaluate seed creds"; return
  fi
  local profj
  profj="$(render_config "$SEED_PROFILE")" || { fail "'docker compose --profile $SEED_PROFILE config' did not parse"; return; }
  "$PYTHON" - "$profj" "$SEED_SVC" "$BALANCE_ROLE_USER" "$SUPERUSER_PW" <<'PY'
import json, sys
svc = json.load(open(sys.argv[1], encoding='utf-8')).get('services', {}).get(sys.argv[2], {})
balance_user, superuser_pw = sys.argv[3], sys.argv[4]
env = svc.get('environment') or {}
# compose renders `environment` as a dict (or list of KEY=VAL); normalize to values.
if isinstance(env, dict):
    values = [str(v) for v in env.values()]
else:
    values = [str(x).split('=', 1)[1] if '=' in str(x) else '' for x in env]
uses_superuser = superuser_pw in values
uses_balance = balance_user in values
if uses_superuser:
    print(f"  -> the seed service's env carries the bootstrap SUPERUSER password — a seed must run as the least-privilege balance role, not the superuser")
    sys.exit(1)
if uses_balance:
    print(f"  the seed service's env carries the balance role user '{balance_user}' (least-privilege, same as the service)")
    sys.exit(0)
print("  NOTE: could not confirm the DB role from the seed's compose env (it may receive creds another way); runtime R1/R5 still prove it connects + writes")
sys.exit(0)
PY
  local rc=$?
  rm -f "$profj" 2>/dev/null
  if [ "$rc" -eq 0 ]; then
    pass "the seed does not use the bootstrap superuser (uses the balance role, or creds resolved at runtime)"
  else
    fail "the seed is wired with the bootstrap SUPERUSER creds — violates least-privilege / the discrete-creds contract"
  fi
}

# Check 3 (static, LOAD-BEARING cheap half) — the demo users carry the PINNED ids in
# realm-export.json, so the Keycloak sub is deterministic and the seed can align to it.
# (spec 08 "Sub alignment" + "Demo dataset".) A MISSING or MISMATCHED pinned id fails
# here without Docker; the runtime R3 then proves the seeded row actually matches it.
check_realm_pinned_ids() {
  section "Check 3 (static) — realm-export pins demo-customer=$PINNED_CUSTOMER_ID, demo-admin=$PINNED_ADMIN_ID (sub alignment)"
  [ -f "$REALM_EXPORT" ] || { fail "realm-export.json not found at $REALM_EXPORT — cannot verify pinned subs"; return; }
  [ -z "$PYTHON" ] && { skip "python not available to parse realm-export.json"; return; }
  local cust_id admin_id cust_email problems=""
  cust_id="$(realm_user_field demo-customer id)"
  admin_id="$(realm_user_field demo-admin id)"
  cust_email="$(realm_user_field demo-customer email)"
  [ "$cust_id" = "$PINNED_CUSTOMER_ID" ] || problems="$problems\n  - demo-customer id is '${cust_id:-<absent>}', expected the pinned '$PINNED_CUSTOMER_ID' (sub would be non-deterministic / misaligned)"
  [ "$admin_id" = "$PINNED_ADMIN_ID" ]   || problems="$problems\n  - demo-admin id is '${admin_id:-<absent>}', expected the pinned '$PINNED_ADMIN_ID'"
  [ "$cust_email" = "$A_EMAIL" ]         || problems="$problems\n  - demo-customer email is '${cust_email:-<absent>}', expected '$A_EMAIL' (the seed's Customer A email must match the realm login)"
  if [ -n "$problems" ]; then
    fail "realm-export pinned-sub contract not met:"; printf '%b\n' "$problems" >&2
  else
    pass "realm-export pins demo-customer=$cust_id, demo-admin=$admin_id, demo-customer email=$cust_email (matches the spec contract)"
  fi
}

# ==================================================================================
# RUNTIME SNAPSHOTS (captured while the stack is up; asserted after teardown)
# ==================================================================================
snapshot_baseline() {
  BASE_MXN="$(pg_scalar "SELECT count(*) FROM currency WHERE code='MXN'")"
  BASE_SYS="$(pg_scalar "SELECT count(*) FROM account WHERE kind='system'")"
  BASE_LIM="$(pg_scalar "SELECT count(*) FROM user_limits")"
  BASE_CUST="$(pg_scalar "SELECT count(*) FROM customer")"
  BASE_CACCT="$(pg_scalar "SELECT count(*) FROM account WHERE kind='customer'")"
}
customer_row_sql() {  # $1 = email
  printf "SELECT c.id, c.name, c.phone, c.email, a.account_number, a.currency, a.status::text, a.balance, a.held, a.spent_today, a.spent_month, (a.spent_today_date IS NOT NULL), (a.spent_month_date IS NOT NULL), (a.spent_today_date = CURRENT_DATE), (a.spent_month_date = CURRENT_DATE) FROM customer c JOIN account a ON a.owner_id = c.id AND a.kind='customer' WHERE c.email='%s' ORDER BY a.account_number LIMIT 1" "$1"
}
acct_count_sql() { printf "SELECT count(*) FROM account a JOIN customer c ON a.owner_id=c.id WHERE c.email='%s' AND a.kind='customer'" "$1"; }

snapshot_after1() {
  A1_ROW="$(pg_row "$(customer_row_sql "$A_EMAIL")")"
  A1_ACCT_COUNT="$(pg_scalar "$(acct_count_sql "$A_EMAIL")")"
  B1_ROW="$(pg_row "$(customer_row_sql "$B_EMAIL")")"
  B1_ACCT_COUNT="$(pg_scalar "$(acct_count_sql "$B_EMAIL")")"
  A1_ID="$(pg_scalar "SELECT id FROM customer WHERE email='$A_EMAIL'")"
  A1_OWNER="$(pg_scalar "SELECT owner_id FROM account WHERE account_number='$A_ACCT'")"
  A1_UPDATED="$(pg_scalar "SELECT updated_at FROM customer WHERE email='$A_EMAIL'")"
  AFTER1_CUR="$(pg_scalar "SELECT count(*) FROM currency")"
  AFTER1_SYS="$(pg_scalar "SELECT count(*) FROM account WHERE kind='system'")"
  AFTER1_LIM="$(pg_scalar "SELECT count(*) FROM user_limits")"
  AFTER1_LIM_CUST="$(pg_scalar "SELECT count(*) FROM user_limits WHERE scope='customer'")"
  AFTER1_CUST="$(pg_scalar "SELECT count(*) FROM customer")"
  AFTER1_CACCT="$(pg_scalar "SELECT count(*) FROM account WHERE kind='customer'")"
}
snapshot_after2() {
  AFTER2_CUST="$(pg_scalar "SELECT count(*) FROM customer")"
  AFTER2_CACCT="$(pg_scalar "SELECT count(*) FROM account WHERE kind='customer'")"
  AFTER2_SYS="$(pg_scalar "SELECT count(*) FROM account WHERE kind='system'")"
  AFTER2_CUR="$(pg_scalar "SELECT count(*) FROM currency")"
  AFTER2_LIM="$(pg_scalar "SELECT count(*) FROM user_limits")"
  A2_UPDATED="$(pg_scalar "SELECT updated_at FROM customer WHERE email='$A_EMAIL'")"
}

# ==================================================================================
# RUNTIME CHECKS (assert over the captured snapshots)
# ==================================================================================

# Baseline — migrations applied the SYSTEM CONSTANTS and NO demo data yet (so the seed's
# effect is attributable, and proves the split "system constants by migration, demo by
# seed"). (spec 08: "System constants are seeded by boot MIGRATIONS, not by this step".)
check_baseline() {
  section "Baseline (runtime) — migrations seeded system constants; no demo data pre-seed"
  local problems=""
  [ "$BASE_MXN" = "1" ]                  || problems="$problems\n  - MXN currency row count is '${BASE_MXN:-?}', expected 1 (migration should have seeded it)"
  [ "$BASE_SYS" = "$EXPECT_SYSTEM_ACCOUNTS" ] || problems="$problems\n  - system/clearing account count is '${BASE_SYS:-?}', expected $EXPECT_SYSTEM_ACCOUNTS"
  [ "$BASE_LIM" = "$EXPECT_GLOBAL_LIMITS" ]   || problems="$problems\n  - user_limits row count is '${BASE_LIM:-?}', expected $EXPECT_GLOBAL_LIMITS (global baseline)"
  [ "$BASE_CUST" = "0" ]                 || problems="$problems\n  - customers already present pre-seed ('${BASE_CUST:-?}') — DB not clean, seed effect not attributable"
  [ "$BASE_CACCT" = "0" ]                || problems="$problems\n  - customer accounts already present pre-seed ('${BASE_CACCT:-?}')"
  if [ -n "$problems" ]; then
    fail "baseline DB state is not as expected after migrations / before seed:"; printf '%b\n' "$problems" >&2
  else
    pass "post-migration baseline: MXN present, $EXPECT_SYSTEM_ACCOUNTS system accounts, $EXPECT_GLOBAL_LIMITS global limit, 0 customers, 0 customer accounts"
  fi
}

check_seed_first_run_ok() {
  section "Seed run #1 (runtime) — the seed executes to completion (exit 0)"
  if [ "$SEED1_RC" = "0" ]; then
    SEED1_OK=1
    pass "\`docker compose --profile $SEED_PROFILE run $SEED_SVC\` exited 0"
  else
    SEED1_OK=0
    fail "seed first run exited ${SEED1_RC:-?} — it did not load the dataset. stderr: $(printf '%s' "$SEED1_ERRMSG" | head -c 400)"
  fi
}

# R1 — the demo dataset is present and EXACTLY matches the spec for both customers.
# (spec 08 "Demo dataset" + DoD "Seed data is present".) Fails on any wrong/missing
# field, a missing customer, or more/fewer than one account per customer.
check_dataset() {
  section "R1 (runtime) — demo customers + accounts match the spec dataset exactly"
  assert_customer "Customer A (demo-customer)" "$A1_ROW" "$A1_ACCT_COUNT" "$PINNED_CUSTOMER_ID" "$A_NAME" "$A_PHONE" "$A_ACCT" "$A_BAL"
  assert_customer "Customer B (Maria Gonzalez)" "$B1_ROW" "$B1_ACCT_COUNT" "$B_ID" "$B_NAME" "$B_PHONE" "$B_ACCT" "$B_BAL"
  # exactly two customers + two customer accounts — nothing extra crept in.
  local problems=""
  [ "$AFTER1_CUST" = "2" ]  || problems="$problems\n  - customer count after seed is '${AFTER1_CUST:-?}', expected exactly 2"
  [ "$AFTER1_CACCT" = "2" ] || problems="$problems\n  - customer-account count after seed is '${AFTER1_CACCT:-?}', expected exactly 2"
  if [ -n "$problems" ]; then
    fail "seeded cardinality is wrong:"; printf '%b\n' "$problems" >&2
  else
    pass "exactly 2 demo customers + 2 customer accounts were seeded"
  fi
}

assert_customer() {
  # $1 label $2 rowstring $3 acctcount $4 exp_id $5 exp_name $6 exp_phone $7 exp_acct $8 exp_bal
  local label="$1" row="$2" acctcount="$3" eid="$4" ename="$5" ephone="$6" eacct="$7" ebal="$8"
  if [ -z "$row" ]; then
    fail "$label: not found in the seeded data (no customer+customer-account row)"; return
  fi
  local problems="" id name phone email acct cur status bal held st sm stdnn smdnn stdtoday smdtoday
  IFS='|' read -r id name phone email acct cur status bal held st sm stdnn smdnn stdtoday smdtoday <<EOF
$row
EOF
  [ "$acctcount" = "1" ]   || problems="$problems\n  - expected exactly 1 active customer account, found '${acctcount:-?}'"
  [ "$id" = "$eid" ]       || problems="$problems\n  - customer.id '$id' != expected '$eid'"
  [ "$name" = "$ename" ]   || problems="$problems\n  - name '$name' != '$ename'"
  [ "$phone" = "$ephone" ] || problems="$problems\n  - phone '$phone' != '$ephone'"
  [ "$acct" = "$eacct" ]   || problems="$problems\n  - account_number '$acct' != '$eacct'"
  [ "$cur" = "MXN" ]       || problems="$problems\n  - currency '$cur' != 'MXN'"
  [ "$status" = "active" ] || problems="$problems\n  - status '$status' != 'active'"
  [ "$bal" = "$ebal" ]     || problems="$problems\n  - balance '$bal' != '$ebal' (minor units)"
  [ "$held" = "0" ]        || problems="$problems\n  - held '$held' != 0"
  [ "$st" = "0" ]          || problems="$problems\n  - spent_today '$st' != 0"
  [ "$sm" = "0" ]          || problems="$problems\n  - spent_month '$sm' != 0"
  [ "$stdnn" = "t" ]       || problems="$problems\n  - spent_today_date is NULL (must be non-null)"
  [ "$smdnn" = "t" ]       || problems="$problems\n  - spent_month_date is NULL (must be non-null)"
  [ "$stdtoday" = "t" ]    || problems="$problems\n  - spent_today_date != CURRENT_DATE"
  [ "$smdtoday" = "t" ]    || problems="$problems\n  - spent_month_date != CURRENT_DATE"
  if [ -n "$problems" ]; then
    fail "$label dataset mismatch:"; printf '%b\n' "$problems" >&2
  else
    pass "$label OK: id=$id, '$name', $phone, acct $acct, balance $bal MXN, held 0, counters 0 @ CURRENT_DATE, active (exactly 1 account)"
  fi
}

# R3 — SUB ALIGNMENT (the load-bearing DoD link): the seeded Customer A id AND the
# seeded account's owner_id BOTH equal the `demo-customer` pinned sub in realm-export.
# (spec 08 "Sub alignment" + DoD "Keycloak logins map to seeded customers".) A
# hardcoded-but-mismatched seed id fails here against the real inserted row.
check_sub_alignment() {
  section "R3 (runtime, LOAD-BEARING) — seeded Customer A id == demo-customer pinned sub (realm-export)"
  local realm_id problems=""
  realm_id="$(realm_user_field demo-customer id)"
  if [ -z "$realm_id" ]; then
    fail "realm-export demo-customer has NO pinned id — the Keycloak sub is non-deterministic, so no seeded customer can align to a real login (see static Check 3)"; return
  fi
  [ -n "$A1_ID" ]                || problems="$problems\n  - no customer row found for '$A_EMAIL' (seed did not create Customer A)"
  [ "$A1_ID" = "$realm_id" ]     || problems="$problems\n  - seeded customer.id '$A1_ID' != realm-export demo-customer sub '$realm_id' (a Keycloak login would NOT map to this customer)"
  [ "$A1_OWNER" = "$realm_id" ]  || problems="$problems\n  - account $A_ACCT owner_id '$A1_OWNER' != the sub '$realm_id' (the account FKs to the wrong owner)"
  [ "$realm_id" = "$PINNED_CUSTOMER_ID" ] || problems="$problems\n  - realm-export sub '$realm_id' != the pinned contract value '$PINNED_CUSTOMER_ID'"
  if [ -n "$problems" ]; then
    fail "sub alignment is broken — a real demo-customer login would not resolve to the seeded customer:"; printf '%b\n' "$problems" >&2
  else
    pass "sub alignment holds: customer.id == account.owner_id == realm-export demo-customer sub == $realm_id"
  fi
}

# R4 — NO COLLATERAL: the seed did not add/modify the MXN currency row, the two
# clearing/system accounts, or any user_limits row. (spec 08: "The seed must NOT
# duplicate or touch these"; "Per-customer limit overrides … are NOT seeded".)
check_no_collateral() {
  section "R4 (runtime) — seed does NOT touch system constants (currency / clearing accounts / user_limits)"
  local problems=""
  [ "$AFTER1_CUR" = "1" ]         || problems="$problems\n  - currency row count changed to '${AFTER1_CUR:-?}' (expected 1, MXN only) — seed touched the currency table"
  [ "$AFTER1_SYS" = "$EXPECT_SYSTEM_ACCOUNTS" ] || problems="$problems\n  - system/clearing account count changed to '${AFTER1_SYS:-?}' (expected $EXPECT_SYSTEM_ACCOUNTS) — seed touched the clearing accounts"
  [ "$AFTER1_LIM" = "$EXPECT_GLOBAL_LIMITS" ]   || problems="$problems\n  - user_limits count changed to '${AFTER1_LIM:-?}' (expected $EXPECT_GLOBAL_LIMITS) — seed touched user_limits"
  [ "$AFTER1_LIM_CUST" = "0" ]    || problems="$problems\n  - ${AFTER1_LIM_CUST} per-customer user_limits row(s) were seeded — per-customer overrides are an admin concern, NOT seeded"
  if [ -n "$problems" ]; then
    fail "the seed altered system constants it must leave alone:"; printf '%b\n' "$problems" >&2
  else
    pass "system constants untouched by the seed: currency=1 (MXN), clearing accounts=$EXPECT_SYSTEM_ACCOUNTS, user_limits=$EXPECT_GLOBAL_LIMITS (global only)"
  fi
}

# R5 — IDEMPOTENCY (core DoD): a SECOND seed run exits 0 (no unique-violation crash) and
# changes nothing — counts unchanged AND Customer A's row untouched (ON CONFLICT DO
# NOTHING, not DO UPDATE). (spec 08: "Upserts are idempotent … a re-run changes nothing";
# DoD "Re-running up is idempotent (seed doesn't duplicate)".)
check_idempotent() {
  section "R5 (runtime) — re-running the seed is a no-op (no duplication, no error, row untouched)"
  local problems=""
  if [ "$SEED2_RC" != "0" ]; then
    problems="$problems\n  - the SECOND seed run exited '${SEED2_RC:-?}' — not idempotent (likely a missing ON CONFLICT DO NOTHING). stderr: $(printf '%s' "$SEED2_ERRMSG" | head -c 300)"
  fi
  [ "$AFTER2_CUST" = "$AFTER1_CUST" ]   || problems="$problems\n  - customer count changed across the re-run: $AFTER1_CUST -> ${AFTER2_CUST:-?} (duplication)"
  [ "$AFTER2_CACCT" = "$AFTER1_CACCT" ] || problems="$problems\n  - customer-account count changed across the re-run: $AFTER1_CACCT -> ${AFTER2_CACCT:-?} (duplication)"
  if [ -n "$A1_UPDATED" ]; then
    [ "$A2_UPDATED" = "$A1_UPDATED" ]   || problems="$problems\n  - Customer A's updated_at changed across the re-run ('$A1_UPDATED' -> '$A2_UPDATED') — the seed did an UPDATE on conflict, not DO NOTHING"
  fi
  # belt-and-braces: the re-run also must not touch the system constants.
  [ "$AFTER2_SYS" = "$EXPECT_SYSTEM_ACCOUNTS" ] || problems="$problems\n  - system account count changed on re-run to '${AFTER2_SYS:-?}'"
  [ "$AFTER2_CUR" = "1" ]                       || problems="$problems\n  - currency count changed on re-run to '${AFTER2_CUR:-?}'"
  [ "$AFTER2_LIM" = "$EXPECT_GLOBAL_LIMITS" ]   || problems="$problems\n  - user_limits count changed on re-run to '${AFTER2_LIM:-?}'"
  if [ -n "$problems" ]; then
    fail "the seed is NOT idempotent:"; printf '%b\n' "$problems" >&2
  else
    pass "re-run is a clean no-op: exit 0, 2 customers / 2 accounts unchanged, Customer A row untouched, system constants unchanged"
  fi
}

# ----------------------------------------------------------------------------------
# Phase runners
# ----------------------------------------------------------------------------------
run_static() {
  section "STATIC CHECKS (no Docker daemon; docker CLI + python + file reads)"
  check_profile_gating
  check_seed_creds
  check_realm_pinned_ids
}

run_runtime() {
  section "RUNTIME CHECKS (Docker daemon — builds balance-service, runs the seed twice)"
  if ! command -v docker >/dev/null 2>&1; then skip "docker CLI not installed — runtime checks skipped"; return; fi
  if ! docker info >/dev/null 2>&1;      then skip "Docker daemon not reachable — runtime checks skipped"; return; fi
  [ -f "$COMPOSE" ]     || { fail "docker-compose.yml not found — cannot run runtime checks"; return; }
  [ -f "$ENV_EXAMPLE" ] || { fail ".env.example not found — cannot resolve runtime env"; return; }
  [ -z "$PYTHON" ] && { skip "python not available — runtime checks need it to read realm-export/config"; return; }

  load_env_values
  if ! discover_seed_service; then
    skip "no \`$SEED_PROFILE\`-profile seed service is defined yet (see static Check 1) — nothing to run; runtime checks skipped"
    return
  fi
  info "seed service under test: '$SEED_SVC' (profile '$SEED_PROFILE')"

  RUNTIME_ENVFILE="$(mktemp)"; cp "$ENV_EXAMPLE" "$RUNTIME_ENVFILE"
  teardown   # fresh slate for THIS isolated project

  # 1) datastores the migrations + seed need (host-unpublished, so no stack collision).
  info "bringing up postgres + redis under project '$PROJECT'"
  local err; err="$(mktemp)"
  if ! dc up -d --no-deps postgres redis >/dev/null 2>"$err"; then
    local m; m="$(cat "$err")"; rm -f "$err"
    if is_env_failure "$m"; then skip "datastores could not start in this environment (offline/registry) — runtime checks skipped"; else fail "datastores failed to start: $(printf '%s' "$m" | head -c 300)"; fi
    teardown; return
  fi
  rm -f "$err"
  if ! wait_health "postgres redis" 150; then
    fail "postgres/redis did not reach healthy (status:$LAST_HEALTH_STATUS )"; teardown; return
  fi

  # 2) build + boot balance-service (--no-deps bypasses the keycloak gate) so its TypeORM
  #    migrations run on boot — the real path that creates the schema + system constants.
  info "building + starting balance-service (--no-deps) to apply migrations on boot — this can take a few minutes…"
  err="$(mktemp)"
  if ! dc up -d --no-deps --build balance-service >/dev/null 2>"$err"; then
    local m; m="$(cat "$err")"; rm -f "$err"
    if is_env_failure "$m"; then skip "balance-service image could not be built/pulled (offline/registry) — runtime checks skipped"; else fail "balance-service build/start failed (real defect): $(printf '%s' "$m" | head -c 400)"; fi
    teardown; return
  fi
  rm -f "$err"
  if ! wait_health "balance-service" 240; then
    fail "balance-service did not reach healthy (status:$LAST_HEALTH_STATUS ) — migrations may not have applied; cannot verify the seed"
    teardown; return
  fi

  # 3) baseline (post-migration, pre-seed), then run the seed TWICE.
  snapshot_baseline

  local e1 e2; e1="$(mktemp)"; e2="$(mktemp)"
  info "running the seed (first time): docker compose --profile $SEED_PROFILE run --rm $SEED_SVC"
  seed_run "$e1" build; SEED1_RC=$?; SEED1_ERRMSG="$(cat "$e1")"; rm -f "$e1"
  if [ "$SEED1_RC" -ne 0 ] && is_env_failure "$SEED1_ERRMSG"; then
    skip "the seed image could not be built/pulled in this environment (offline/registry) — runtime checks skipped"
    rm -f "$e2"; teardown; return
  fi
  snapshot_after1

  if [ "$SEED1_RC" -eq 0 ]; then
    info "running the seed (second time) to prove idempotency"
    seed_run "$e2" nobuild; SEED2_RC=$?; SEED2_ERRMSG="$(cat "$e2")"
  else
    SEED2_RC="skipped"; SEED2_ERRMSG="(first run failed; second run not attempted)"
  fi
  rm -f "$e2"
  snapshot_after2

  info "final teardown of project '$PROJECT' (with -v)"
  teardown

  # 4) assertions over the captured snapshots.
  check_baseline
  check_seed_first_run_ok
  if [ "$SEED1_OK" -eq 1 ]; then
    check_dataset
    check_sub_alignment
    check_no_collateral
    check_idempotent
  else
    skip "R1/R3/R4/R5 skipped — the seed's first run failed, so there is no dataset to verify (see Seed run #1)"
  fi
}

# Idempotent cleanup of anything this suite creates; safe on any exit.
global_cleanup() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && [ -f "$COMPOSE" ]; then
    dc down -v --remove-orphans >/dev/null 2>&1
  fi
  [ -n "${RUNTIME_ENVFILE:-}" ] && rm -f "$RUNTIME_ENVFILE" 2>/dev/null
  [ -n "${DC_FALLBACK_ENV:-}" ] && rm -f "$DC_FALLBACK_ENV" 2>/dev/null
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
