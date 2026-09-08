#!/usr/bin/env bash
# lib.sh — shared helpers and all verification checks for the Docker Compose spine
# (Spec 00 — Macro Architecture). Sourced by run.sh; defines functions only, never exits.
#
# Checks are written FROM the spec (specs/00-architecture.md), not from the compose
# file's contents: they parse whatever the implementor produces and assert the intended
# invariants, so they can fail on a real defect.
#
# Scope of this step (the "spine"): five networks + the three datastores (postgres,
# redis, mongo) coming up healthy + .env.example + root .gitignore. Keycloak, kong,
# nginx and the app services are NOT part of this step and are not tested here.

# ----------------------------------------------------------------------------------
# Environment / globals
# ----------------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$REPO_ROOT/docker-compose.yml"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

# Runtime project isolation — kept separate from any real stack so teardown with -v
# can only ever remove THIS test's containers/volumes/networks.
PROJECT="scfin-macro-test"
PROBE_POS="scfin-macro-probe-pos"
PROBE_NEG="scfin-macro-probe-neg"
STANDIN_NET="scfin-macro-edge-standin"

CONFIG_JSON_FILE=""     # cached resolved-config JSON (temp path); cleaned on exit
LAST_CONFIG_ERR=""      # stderr of the last failed `docker compose config`
RUNTIME_ENVFILE=""      # temp copy of .env.example used for `up`; cleaned on exit

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

# Pick a Python that actually runs (jq is not available in this environment).
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
# Resolved-config helper — the canonical way to inspect the compose file.
#   Returns: 0 ok (CONFIG_JSON_FILE populated), 1 parse failed, 3 docker CLI absent.
# `docker compose config` needs the docker CLI but NOT the daemon, so this is a
# static check. It substitutes .env.example values via a throwaway --env-file so a
# real (git-ignored) .env is never touched or required.
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

# docker compose wrapper for THIS project that ALWAYS supplies an --env-file.
# Step 2 added `keycloak` to the spine with `${KEYCLOAK_PORT}` in its `ports:`; any
# compose subcommand that parses the file (`ps`, `down`, …) now needs that var
# interpolated or it errors "no port specified" and silently does nothing. This wrapper
# feeds the runtime env copy (or a throwaway from .env.example) so those calls keep
# working. It changes no assertion — only makes the mechanics correct as the spine grew.
DC_FALLBACK_ENV=""
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

# ----------------------------------------------------------------------------------
# STATIC CHECKS (no daemon required)
# ----------------------------------------------------------------------------------

# Check 1 — `docker compose config` parses with .env.example values. (DoD §8: skeleton valid)
check_config_parses() {
  section "Check 1 — docker compose config parses (DoD §8: skeleton exists & is valid)"
  if [ ! -f "$COMPOSE" ]; then fail "docker-compose.yml not found at $COMPOSE"; return; fi
  if [ ! -f "$ENV_EXAMPLE" ]; then fail ".env.example not found at $ENV_EXAMPLE (needed to resolve config)"; return; fi
  build_config; local rc=$?
  case $rc in
    0) pass "docker compose config resolved successfully using .env.example values" ;;
    3) skip "docker CLI not installed — cannot run 'docker compose config'" ;;
    *) fail "docker compose config failed to parse:"; printf '%s\n' "$LAST_CONFIG_ERR" >&2 ;;
  esac
}

# Check 2 — exactly the five networks are declared. (DoD §8: five networks; §2)
# NB: this parses the RAW top-level `networks:` block, NOT `docker compose config`.
# `docker compose config` prunes networks that no started service references, and in
# this step four of the five networks (the edge/app planes) have no members yet, so the
# resolved config would only show `data`. The DoD requires all five to be *declared*.
check_networks() {
  section "Check 2 — exactly the five networks declared (DoD §8: five networks)"
  if [ ! -f "$COMPOSE" ]; then fail "docker-compose.yml not found at $COMPOSE"; return; fi
  if [ -z "$PYTHON" ]; then skip "python not available to parse the networks block"; return; fi
  if "$PYTHON" - "$COMPOSE" <<'PY'
import sys, re
text = open(sys.argv[1], encoding='utf-8').read()
keys = None
try:
    import yaml
    doc = yaml.safe_load(text) or {}
    keys = set((doc.get("networks") or {}).keys())
except ImportError:
    # Block-style fallback: collect the immediate children of the top-level `networks:`.
    keys = set()
    in_block = False
    child_indent = None
    for ln in text.splitlines():
        if re.match(r'^networks:\s*(#.*)?$', ln):
            in_block = True; child_indent = None; continue
        if in_block:
            if ln.strip() and re.match(r'^\S', ln):   # a new column-0 key ends the block
                break
            m = re.match(r'^(\s+)([A-Za-z0-9_.\-]+):\s*(#.*)?$', ln)
            if m:
                ind = len(m.group(1))
                child_indent = ind if child_indent is None else child_indent
                if ind == child_indent:
                    keys.add(m.group(2))
expected = {"edge-public", "edge-internal", "app-public", "app-internal", "data"}
missing = expected - keys
extra = keys - expected
if missing:
    print("  missing networks: " + ", ".join(sorted(missing)))
if extra:
    print("  unexpected extra networks: " + ", ".join(sorted(extra)))
if missing or extra:
    sys.exit(1)
print("  declared exactly: " + ", ".join(sorted(keys)))
PY
  then pass "exactly the five expected networks are declared (no missing, no extras)"
  else fail "network set does not match the five required by §2"
  fi
}

# Check 3 — each datastore is on `data` and on no edge-*/app-* network. (§2 membership)
check_datastore_networks() {
  section "Check 3 — datastores on 'data' only, never edge-*/app-* (spec §2 membership)"
  build_config; local rc=$?
  [ $rc -eq 3 ] && { skip "docker CLI absent — cannot resolve service networks"; return; }
  [ $rc -ne 0 ] && { fail "config did not parse — cannot check membership (see Check 1)"; return; }
  if "$PYTHON" - "$CONFIG_JSON_FILE" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
services = cfg.get("services") or {}
bad = False
for name in ("postgres", "redis", "mongo"):
    svc = services.get(name)
    if svc is None:
        print(f"  datastore '{name}' is not defined as a service"); bad = True; continue
    nets = set((svc.get("networks") or {}).keys())
    print(f"  {name} networks: {sorted(nets) if nets else '(none -> default)'}")
    if "data" not in nets:
        print(f"    -> '{name}' is NOT attached to 'data'"); bad = True
    leaked = sorted(n for n in nets if n.startswith("edge-") or n.startswith("app-"))
    if leaked:
        print(f"    -> '{name}' is attached to forbidden network(s): {leaked}"); bad = True
sys.exit(1 if bad else 0)
PY
  then pass "postgres, redis, mongo each attached to 'data' and to no edge-*/app-* network"
  else fail "datastore network membership violates §2 (must be 'data' only)"
  fi
}

# Check 4 — no datastore publishes ports; no service publishes a host port
# outside {8080,8081,8082}. (DoD §8: only :8080/:8081/:8082 host-published)
check_ports() {
  section "Check 4 — host port publishing restricted to 8080/8081/8082 (DoD §8)"
  build_config; local rc=$?
  [ $rc -eq 3 ] && { skip "docker CLI absent — cannot resolve ports"; return; }
  [ $rc -ne 0 ] && { fail "config did not parse — cannot check ports (see Check 1)"; return; }
  if "$PYTHON" - "$CONFIG_JSON_FILE" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
services = cfg.get("services") or {}
datastores = {"postgres", "redis", "mongo"}
allowed = {"8080", "8081", "8082"}
bad = False
any_published = False
for name, svc in services.items():
    ports = svc.get("ports") or []
    if name in datastores and ports:
        print(f"  datastore '{name}' declares a ports: mapping (must not host-publish): {ports}")
        bad = True
    for p in ports:
        pub = p.get("published") if isinstance(p, dict) else None
        pub = "" if pub is None else str(pub)
        if pub == "":
            print(f"  service '{name}' publishes an ephemeral/random host port (not allowed)")
            bad = True
            continue
        any_published = True
        # tolerate ranges by checking each endpoint
        if any(tok and tok not in allowed for tok in pub.split("-")):
            print(f"  service '{name}' publishes host port {pub} (only 8080/8081/8082 allowed)")
            bad = True
if not any_published and not bad:
    print("  no host ports published (as expected for the current spine)")
sys.exit(1 if bad else 0)
PY
  then pass "no datastore host-publishes; any published port is within {8080,8081,8082}"
  else fail "port publishing violates DoD §8 (datastore published, or port outside 8080/8081/8082)"
  fi
}

# Check 5 — every ${VAR} referenced in docker-compose.yml is documented in .env.example.
# (DoD §8: .env.example documents every required variable)
# Interpretation: a variable is *required* if any reference lacks an inline default
# (${VAR}, ${VAR:?..}, $VAR). Vars that always carry an inline default (${VAR:-..})
# are optional — reported as a NOTE, not a failure. See README for rationale.
check_env_vars() {
  section "Check 5 — every referenced \${VAR} documented in .env.example (DoD §8)"
  if [ ! -f "$COMPOSE" ]; then fail "docker-compose.yml not found"; return; fi
  if [ ! -f "$ENV_EXAMPLE" ]; then fail ".env.example not found — no variables documented"; return; fi
  if [ -z "$PYTHON" ]; then skip "python not available to parse variable references"; return; fi
  if "$PYTHON" - "$COMPOSE" "$ENV_EXAMPLE" <<'PY'
import re, sys
compose = open(sys.argv[1], encoding='utf-8').read()
env = open(sys.argv[2], encoding='utf-8').read()
compose = compose.replace("$$", "")  # drop escaped literal dollars

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
    if m:
        defined.add(m.group(1))

req_missing = sorted(required - defined)
opt_missing = sorted((optional - required) - defined)

print(f"  referenced: {len(required | optional)} var(s); documented in .env.example: {len(defined)}")
for v in opt_missing:
    print(f"  NOTE: '{v}' has an inline default and is not in .env.example (optional)")
for v in req_missing:
    print(f"  MISSING (required): '{v}' is referenced without a default but not documented")
sys.exit(1 if req_missing else 0)
PY
  then pass ".env.example documents every required variable referenced by the compose file"
  else fail ".env.example is missing a required variable (fresh clone would break)"
  fi
}

# Check 6 — .gitignore ignores .env but NOT .env.example. (no-secrets-in-repo rule)
check_gitignore() {
  section "Check 6 — .gitignore ignores .env, keeps .env.example (no-secrets rule)"
  command -v git >/dev/null 2>&1 || { skip "git not installed — cannot verify ignore rules"; return; }
  git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || { skip "not a git repository"; return; }

  git -C "$REPO_ROOT" check-ignore -q -- .env; local rc_env=$?
  git -C "$REPO_ROOT" check-ignore -q -- .env.example; local rc_ex=$?
  # Alternate secret-bearing filenames NestJS ConfigModule workflows produce
  # (later steps) must also be ignored, not just the canonical `.env`.
  git -C "$REPO_ROOT" check-ignore -q -- .env.local; local rc_alt=$?
  # rc: 0 = path is ignored, 1 = not ignored, 128 = error
  if [ "$rc_env" -eq 128 ] || [ "$rc_ex" -eq 128 ] || [ "$rc_alt" -eq 128 ]; then
    fail "git check-ignore errored (.env rc=$rc_env, .env.example rc=$rc_ex, .env.local rc=$rc_alt)"; return
  fi
  local ok=1
  if [ "$rc_env" -ne 0 ]; then
    fail ".env is NOT git-ignored — a secret-bearing file could be committed"; ok=0
  fi
  if [ "$rc_alt" -ne 0 ]; then
    fail ".env.local is NOT git-ignored — an alternate secret file could be committed"; ok=0
  fi
  if [ "$rc_ex" -eq 0 ]; then
    fail ".env.example IS git-ignored — it must be committed as documentation"; ok=0
  fi
  [ "$ok" -eq 1 ] && pass ".env / .env.local are ignored and .env.example is committable (git check-ignore)"
}

# Check 7 — all three datastores define a healthcheck. (supports DoD §8 "healthy" + §5)
check_healthchecks() {
  section "Check 7 — every datastore defines a healthcheck (supports DoD §8 healthy, §5)"
  build_config; local rc=$?
  [ $rc -eq 3 ] && { skip "docker CLI absent — cannot resolve healthchecks"; return; }
  [ $rc -ne 0 ] && { fail "config did not parse — cannot check healthchecks (see Check 1)"; return; }
  if "$PYTHON" - "$CONFIG_JSON_FILE" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding='utf-8'))
services = cfg.get("services") or {}
bad = False
for name in ("postgres", "redis", "mongo"):
    svc = services.get(name)
    if svc is None:
        print(f"  datastore '{name}' is not defined"); bad = True; continue
    hc = svc.get("healthcheck")
    if not hc or hc.get("disable") is True or not hc.get("test"):
        print(f"  datastore '{name}' has no usable healthcheck (compose can't gate on health)")
        bad = True
    else:
        print(f"  {name} healthcheck: {hc.get('test')}")
sys.exit(1 if bad else 0)
PY
  then pass "postgres, redis, mongo each define a healthcheck"
  else fail "a datastore is missing a healthcheck — 'comes up healthy' cannot be enforced"
  fi
}

# ----------------------------------------------------------------------------------
# RUNTIME CHECKS (require Docker daemon)
# ----------------------------------------------------------------------------------

# Check 8 — datastores reach `healthy`. (DoD §8: comes up healthy)
check_health() {
  section "Check 8 — datastores reach healthy (DoD §8: comes up healthy)"
  local svcs="postgres redis mongo" timeout=120 waited=0 interval=3
  while :; do
    local pending=0 status_line="" s cid st
    for s in $svcs; do
      cid="$(dc ps -q "$s" 2>/dev/null | head -1)"
      if [ -z "$cid" ]; then status_line="$status_line $s=absent"; pending=1; continue; fi
      st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null)"
      status_line="$status_line $s=$st"
      case "$st" in
        healthy)   ;;
        unhealthy) fail "Check 8 — '$s' reported UNHEALTHY (status:$status_line )"; return ;;
        *)         pending=1 ;;   # starting / created / none (no healthcheck) / absent
      esac
    done
    if [ "$pending" -eq 0 ]; then
      pass "postgres, redis, mongo all reached 'healthy' (status:$status_line )"; return
    fi
    if [ "$waited" -ge "$timeout" ]; then
      fail "Check 8 — datastores not all healthy within ${timeout}s (last:$status_line ) — a '=none' means no healthcheck"; return
    fi
    sleep "$interval"; waited=$((waited + interval))
  done
}

# Check 9 — a datastore is reachable from `data` but not from the edge. (DoD §8 isolation)
check_isolation() {
  section "Check 9 — postgres reachable from 'data', unreachable from edge (DoD §8 isolation)"
  if ! docker image inspect alpine >/dev/null 2>&1; then
    if ! docker pull alpine >/dev/null 2>&1; then
      skip "Check 9 — 'alpine' image unavailable (offline?) — isolation probe skipped"; return
    fi
  fi

  local net_data net_edge standin_used=0
  net_data="$(compose_net_name data)"
  if [ -z "$net_data" ]; then fail "Check 9 — 'data' network not found for project '$PROJECT'"; return; fi

  net_edge="$(compose_net_name edge-public)"
  if [ -z "$net_edge" ]; then
    # In this step edge-public has no members, so compose does not create it.
    # Use a standalone off-'data' bridge as the edge stand-in: the invariant proven
    # is identical — a datastore is unreachable from any non-'data' network.
    docker network create "$STANDIN_NET" >/dev/null 2>&1
    net_edge="$STANDIN_NET"; standin_used=1
    info "edge-public has no members yet this step; using an off-'data' stand-in network"
  fi

  docker rm -f "$PROBE_POS" "$PROBE_NEG" >/dev/null 2>&1
  # Positive control: on 'data', postgres MUST be reachable.
  docker run --rm --name "$PROBE_POS" --network "$net_data" alpine \
    sh -c 'nc -z -w3 postgres 5432' >/dev/null 2>&1; local pos=$?
  # Negative control: off 'data', postgres MUST be unreachable.
  docker run --rm --name "$PROBE_NEG" --network "$net_edge" alpine \
    sh -c 'nc -z -w3 postgres 5432' >/dev/null 2>&1; local neg=$?

  [ "$standin_used" -eq 1 ] && docker network rm "$STANDIN_NET" >/dev/null 2>&1

  if [ "$pos" -eq 0 ] && [ "$neg" -ne 0 ]; then
    pass "postgres reachable from 'data' (nc exit $pos) and unreachable from edge (nc exit $neg)"
  else
    fail "isolation broken: reachable-from-data exit=$pos (want 0), reachable-from-edge exit=$neg (want non-zero)"
  fi
}

# ----------------------------------------------------------------------------------
# Phase runners
# ----------------------------------------------------------------------------------
run_static() {
  section "STATIC CHECKS (no Docker daemon required)"
  check_config_parses
  check_networks
  check_datastore_networks
  check_ports
  check_env_vars
  check_gitignore
  check_healthchecks
}

run_runtime() {
  section "RUNTIME CHECKS (require Docker daemon)"
  if ! command -v docker >/dev/null 2>&1; then
    skip "docker CLI not installed — runtime checks 8 & 9 skipped"; return
  fi
  if ! docker info >/dev/null 2>&1; then
    skip "Docker daemon not reachable — runtime checks 8 & 9 skipped"; return
  fi
  if [ ! -f "$COMPOSE" ]; then fail "docker-compose.yml not found — cannot run runtime checks"; return; fi
  if [ ! -f "$ENV_EXAMPLE" ]; then fail ".env.example not found — cannot resolve runtime env"; return; fi

  # The spine pins container_name on the datastores (global names). If a stack is
  # already running one of those names under another project, an isolated parallel
  # `up` would collide — and this suite must NEVER tear down a stack it did not
  # create. Detect and skip cleanly (a live stack is a precondition, not a defect).
  local conflict="" n cid proj
  for n in postgres redis mongo; do
    cid="$(docker ps -aq --filter "name=^${n}$" 2>/dev/null | head -1)"
    if [ -n "$cid" ]; then
      proj="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$cid" 2>/dev/null)"
      [ "$proj" = "$PROJECT" ] || conflict="$conflict ${n}(project='${proj:-none}')"
    fi
  done
  if [ -n "$conflict" ]; then
    skip "Check 8 — container name(s) already in use:$conflict — stop that stack ('docker compose down') then re-run; the spine pins container_name, so the isolated runtime test cannot run alongside a live stack"
    skip "Check 9 — isolation skipped (name conflict; see Check 8)"
    return
  fi

  RUNTIME_ENVFILE="$(mktemp)"; cp "$ENV_EXAMPLE" "$RUNTIME_ENVFILE"
  # Fresh slate for this isolated test project.
  dc down -v --remove-orphans >/dev/null 2>&1

  info "bringing up postgres, redis, mongo under project '$PROJECT'"
  local err; err="$(mktemp)"
  if ! dc up -d --no-build postgres redis mongo >/dev/null 2>"$err"; then
    fail "Check 8 — 'docker compose up' failed:"; cat "$err" >&2; rm -f "$err"
    skip "Check 9 — isolation skipped (stack failed to start)"
    dc down -v --remove-orphans >/dev/null 2>&1
    return
  fi
  rm -f "$err"

  check_health
  check_isolation

  info "tearing down project '$PROJECT'"
  dc down -v --remove-orphans >/dev/null 2>&1
}

# Idempotent cleanup of everything this suite may create; safe to call on any exit.
global_cleanup() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker rm -f "$PROBE_POS" "$PROBE_NEG" >/dev/null 2>&1
    docker network rm "$STANDIN_NET" >/dev/null 2>&1
    # dc supplies an env file even when RUNTIME_ENVFILE is unset, so `down` can
    # interpolate keycloak's ${KEYCLOAK_PORT} and actually tear the project down.
    [ -f "$COMPOSE" ] && dc down -v --remove-orphans >/dev/null 2>&1
  fi
  [ -n "${CONFIG_JSON_FILE:-}" ]  && rm -f "$CONFIG_JSON_FILE" 2>/dev/null
  [ -n "${RUNTIME_ENVFILE:-}" ]   && rm -f "$RUNTIME_ENVFILE" 2>/dev/null
  [ -n "${DC_FALLBACK_ENV:-}" ]   && rm -f "$DC_FALLBACK_ENV" 2>/dev/null
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
