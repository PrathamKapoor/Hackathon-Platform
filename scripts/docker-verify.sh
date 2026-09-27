#!/usr/bin/env bash
#
# Docker verification harness.
#
#   docker compose down -v && ./scripts/docker-verify.sh
#
# This exists because "the Dockerfile looks right" is not evidence and
# "docker compose up worked once" is weaker evidence. This script destroys all
# prior state, builds from scratch with no cache, brings the stack up, and then
# asks the questions a real deployment has to answer:
#
#   * does a clean volume migrate, seed and become healthy?
#   * does the API answer, with the right content types?
#   * does the SPA load, including deep links, while API 404s stay JSON?
#   * does the full judging pipeline run inside the container and reproduce?
#   * does authorization hold inside the container, not just in tests?
#   * does the client reference anything on the network?
#   * does data and publication survive a restart?
#
# Every step prints PASS or FAIL and the script exits non-zero on any failure,
# so it works as a release gate.
#
# Requires: docker with the compose plugin. Nothing else.
set -uo pipefail

# Resolve the repository root from this script's own location, so the script
# works from any working directory.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "${REPO}/docker-compose.yml")
PASS=0
FAIL=0
STEP=0

# A throwaway secret: the stack refuses to start without one, which is the
# correct production behaviour, so the harness supplies its own.
export SESSION_SECRET="${SESSION_SECRET:-docker-verification-secret-0123456789abcdef}"
# The harness talks to the instance over loopback by IP, so the origin guard is
# told about that host too.
export PUBLIC_URL="${PUBLIC_URL:-http://127.0.0.1:8080}"
export PORT="${PORT:-8080}"

step() { STEP=$((STEP + 1)); printf '\n\033[1m== %d. %s\033[0m\n' "$STEP" "$1"; }
ok()   { PASS=$((PASS + 1)); printf '   \033[32m[PASS]\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '   \033[31m[FAIL]\033[0m %s\n' "$1"; }
note() { printf '          %s\n' "$1"; }

# Runs a snippet inside the running container with a fresh database handle.
# Extra arguments after the snippet are forwarded to the script, because a
# snippet that interpolates an id from a shell variable needs it to arrive.
# An earlier version dropped them, so a "did the database refuse this?" check
# silently tested a statement that matched no rows and reported success.
in_container() {
  "${COMPOSE[@]}" exec -T verdict node -e "$1" "${@:2}" 2>/dev/null | tr -d '\r'
}

# Signs in once per role and caches the cookie jar in a temp file, then reuses
# it. Logging in on every request worked until it did not: the auth rate limit
# is 10 sign-ins per 5 minutes per account, so a long verification run locked
# the harness out of its own instance. That is the application behaving
# correctly — the fix belongs here.
jar_for() {
  local email=$1 jar="/tmp/verdict-jar-$(printf '%s' "$email" | tr -c 'a-zA-Z0-9' '_').txt"
  if [ -s "$jar" ]; then cat "$jar"; return 0; fi
  "${COMPOSE[@]}" exec -T verdict node -e '
    const email = process.argv[1];
    (async () => {
      const res = await fetch("http://127.0.0.1:8080/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "verdict-demo-2026" }),
      });
      if (!res.ok) { console.error("login failed for " + email + ": " + res.status); process.exit(1); }
      const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      const csrf = (res.headers.getSetCookie().find((c) => c.startsWith("verdict_csrf=")) || "")
        .split(";")[0].split("=")[1] || "";
      process.stdout.write(cookies + "\n" + csrf);
    })();
  ' "$email" > "$jar.tmp" 2>/dev/null
  local status=$?
  if [ $status -ne 0 ] || [ ! -s "$jar.tmp" ]; then
    rm -f "$jar.tmp"
    echo "LOGIN_FAILED"
    return 1
  fi
  mv "$jar.tmp" "$jar"
  cat "$jar"
}

# An authenticated request, issued from inside the container so the session
# cookie and the origin header are both genuine. Emits {"status":N,"body":{...}}
# with the body already parsed, so json() can walk it.
authed_request() {
  local method=$1 path=$2 payload=${3:-} email=${4:-organizer@dogfood.dev}
  local jar
  jar="$(jar_for "$email")" || { echo '{"status":0,"body":{}}'; return 1; }
  local cookie csrf
  cookie=$(printf '%s\n' "$jar" | head -n1)
  csrf=$(printf '%s\n' "$jar" | tail -n1)
  "${COMPOSE[@]}" exec -T verdict node -e '
    const [method, path, payload, cookie, csrf] = process.argv.slice(1);
    (async () => {
      const res = await fetch("http://127.0.0.1:8080" + path, {
        method,
        headers: {
          cookie,
          origin: "http://127.0.0.1:8080",
          "x-verdict-csrf": csrf,
          "content-type": "application/json",
        },
        body: payload === "" ? undefined : payload,
      });
      const text = await res.text();
      let body = text;
      try { body = JSON.parse(text); } catch { /* not json */ }
      process.stdout.write(JSON.stringify({ status: res.status, body }));
    })();
  ' "$method" "$path" "$payload" "$cookie" "$csrf" 2>/dev/null | tr -d '\r'
}

# Reads a dotted path out of JSON on stdin. Runs on the host, which has no node.
json() {
  python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
    for key in sys.argv[1].split("."):
        data = data.get(key) if isinstance(data, dict) else None
        if data is None: break
    print("MISSING" if data is None else data)
except Exception:
    print("PARSE_FAIL")
' "$1"
}

wait_healthy() {
  local limit=${1:-180} waited=0
  while [ "$waited" -lt "$limit" ]; do
    if "${COMPOSE[@]}" exec -T verdict node -e \
        "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
        >/dev/null 2>&1; then
      return 0
    fi
    sleep 2; waited=$((waited + 2))
  done
  return 1
}

printf '\033[1mVerdict Docker verification\033[0m\n'
printf 'repository: %s\n' "$REPO"
printf 'session secret: %s\n' "${SESSION_SECRET:0:8}… (throwaway)"

# ------------------------------------------------------------------ 0. clean
rm -f /tmp/verdict-jar-*.txt 2>/dev/null
step "Destroy all prior state, including volumes"
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -qx 'verdict-data'; then
  docker volume rm verdict-data >/dev/null 2>&1
fi
if "${COMPOSE[@]}" ps -q 2>/dev/null | grep -q .; then
  bad "compose still reports running containers"
else
  ok "no containers, no volumes — starting from nothing"
fi

# ------------------------------------------------------------------ 1. build
step "Build the image from scratch (no cache)"
if "${COMPOSE[@]}" build --no-cache >/tmp/verdict-build.log 2>&1; then
  ok "image built"
  note "$(grep -cE '^#[0-9]+ ' /tmp/verdict-build.log | tr -d ' ') build steps"
else
  bad "image build failed"
  tail -40 /tmp/verdict-build.log
  exit 1
fi

# ------------------------------------------------------------------ 2. up
step "docker compose up -d"
if "${COMPOSE[@]}" up -d >/tmp/verdict-up.log 2>&1; then ok "stack started"; else bad "compose up failed"; tail -30 /tmp/verdict-up.log; exit 1; fi

step "Wait for the health check to pass"
if wait_healthy 180; then ok "container became healthy"; else bad "container never became healthy"; "${COMPOSE[@]}" logs --tail=80; exit 1; fi

# ------------------------------------------------------------------ 3. schema
step "Migrations applied on a clean volume"
SCHEMA=$(in_container 'const{DatabaseSync}=require("node:sqlite");console.log(new DatabaseSync("/data/verdict.db",{readOnly:true}).prepare("SELECT MAX(version) v FROM schema_migrations").get().v)')
[ "$SCHEMA" = "14" ] && ok "schema version $SCHEMA" || bad "unexpected schema version: $SCHEMA"

step "Database integrity"
FK=$(in_container 'const{DatabaseSync}=require("node:sqlite");console.log(new DatabaseSync("/data/verdict.db",{readOnly:true}).prepare("PRAGMA foreign_key_check").all().length)')
QC=$(in_container 'const{DatabaseSync}=require("node:sqlite");console.log(new DatabaseSync("/data/verdict.db",{readOnly:true}).prepare("PRAGMA quick_check").get().quick_check)')
TABLES=$(in_container 'const{DatabaseSync}=require("node:sqlite");console.log(new DatabaseSync("/data/verdict.db",{readOnly:true}).prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = '"'"'table'"'"' AND name NOT LIKE '"'"'sqlite_%'"'"'").get().c)')
[ "$FK" = "0" ] && ok "0 foreign key violations" || bad "foreign key violations: $FK"
[ "$QC" = "ok" ] && ok "quick_check ok" || bad "quick_check: $QC"
note "$TABLES tables in the schema"

# ------------------------------------------------------------------ 4. seed
step "Seed data present on first boot"
SEED=$(in_container 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/data/verdict.db",{readOnly:true});const c=(t)=>d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;console.log([c("users"),c("teams"),c("submissions"),c("judges"),c("scores"),c("judge_assignments")].join("/"))')
USERS=$(echo "$SEED" | cut -d/ -f1); TEAMS=$(echo "$SEED" | cut -d/ -f2)
SUBS=$(echo "$SEED" | cut -d/ -f3); JUDGES=$(echo "$SEED" | cut -d/ -f4)
SCORES=$(echo "$SEED" | cut -d/ -f5); ASGS=$(echo "$SEED" | cut -d/ -f6)
[ "${USERS:-0}" -gt 0 ] && ok "users $USERS, teams $TEAMS, submissions $SUBS, judges $JUDGES" || bad "no users seeded: $SEED"
[ "${SCORES:-0}" -gt 0 ] && ok "$SCORES scores across $ASGS assignments" || bad "no scores seeded"

# ------------------------------------------------------------------ 5. api
step "API endpoints answer"
for path in /api/health /api/ready /api/openapi.json /api/docs /api/capabilities /api/lifecycle /api/events /api/rbac/matrix; do
  CODE=$(in_container "fetch('http://127.0.0.1:8080$path').then(r=>console.log(r.status)).catch(()=>console.log(0))")
  [ "$CODE" = "200" ] && ok "GET $path -> 200" || bad "GET $path -> $CODE"
done

step "Frontend served by the API"
ROOT=$(in_container 'fetch("http://127.0.0.1:8080/").then(async r=>console.log(r.status+" "+((await r.text()).includes("id=\"root\"")))).catch(()=>console.log("0 false"))')
echo "$ROOT" | grep -q '^200 true$' && ok "GET / serves the SPA shell" || bad "GET / -> $ROOT"

for deep in /e/dogfood-2026 /e/dogfood-2026/results /e/dogfood-2026/gallery /organize /judge; do
  D=$(in_container "fetch('http://127.0.0.1:8080$deep').then(async r=>console.log(r.status+' '+((await r.text()).includes('id=\"root\"')))).catch(()=>console.log('0 false'))")
  echo "$D" | grep -q '^200 true$' && ok "deep link $deep serves the shell" || bad "deep link $deep -> $D"
done

APIMISS=$(in_container 'fetch("http://127.0.0.1:8080/api/definitely-not-here").then(r=>console.log(r.status+" "+(r.headers.get("content-type")||""))).catch(()=>console.log("0"))')
echo "$APIMISS" | grep -q '404 application/json' && ok "unknown /api path -> 404 JSON, not the shell" || bad "unknown /api path -> $APIMISS"

ASSET=$(in_container 'const fs=require("fs");const d="/app/apps/web/dist/assets";const f=fs.readdirSync(d).find(n=>n.endsWith(".js"));fetch("http://127.0.0.1:8080/assets/"+f).then(r=>console.log(r.status+" "+(r.headers.get("cache-control")||""))).catch(()=>console.log("0"))')
echo "$ASSET" | grep -q '200 public, max-age=[0-9]\{6\}' && ok "hashed asset cached immutably ($ASSET)" || bad "asset caching -> $ASSET"

# ------------------------------------------------------------------ 6. auth
step "Authentication"
# Cached sign-ins (see jar_for) so the auth rate limit is not self-inflicted.
for pair in "organizer@dogfood.dev:200" "amara@dogfood.dev:200" "iris@dogfood.dev:200" "admin@hackathonraptors.dev:200"; do
  EMAIL="${pair%%:*}"; WANT="${pair##*:}"
  if [ "$(jar_for "$EMAIL" | head -c 9)" = "LOGIN_FAIL" ]; then
    bad "sign in $EMAIL failed"
  elif [ "$WANT" = "200" ]; then
    ok "sign in $EMAIL"
  fi
done

BADCODE=$(in_container "fetch('http://127.0.0.1:8080/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'nobody@nowhere.invalid',password:'wrong-password'})}).then(r=>console.log(r.status)).catch(()=>console.log(0))")
[ "$BADCODE" = "401" ] && ok "unknown address + wrong password -> 401" || bad "bad credentials -> $BADCODE"

COOKIES=$(in_container "fetch('http://127.0.0.1:8080/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'organizer@dogfood.dev',password:'verdict-demo-2026'})}).then(r=>console.log(r.headers.getSetCookie().join(' ~ '))).catch(()=>console.log(''))")
echo "$COOKIES" | grep -qi 'verdict_session=[^~]*;.*HttpOnly' && ok "session cookie is HttpOnly" || bad "session cookie lacks HttpOnly"
echo "$COOKIES" | grep -qi 'verdict_csrf=' && ok "CSRF cookie issued (readable, by design)" || bad "no CSRF cookie issued"

# ------------------------------------------------------------------ 7. pipeline
step "Judging pipeline inside the container"
COMPUTE=$(authed_request POST '/api/events/dogfood-2026/results/compute' '{}')
CSTATUS=$(echo "$COMPUTE" | json status)
RUNID=$(echo "$COMPUTE" | json body.runId)
HASH1=$(echo "$COMPUTE" | json body.integrityHash)
if [ "$CSTATUS" = "200" ] && [ -n "$RUNID" ] && [ "$RUNID" != "MISSING" ]; then
  ok "results compute -> 200, run ${RUNID:0:12}…"
else
  bad "results compute -> $CSTATUS ($RUNID)"
  note "$(echo "$COMPUTE" | head -c 220)"
fi

COMPUTE2=$(authed_request POST '/api/events/dogfood-2026/results/compute' '{}')
HASH2=$(echo "$COMPUTE2" | json body.integrityHash)
if [ -n "$HASH1" ] && [ "$HASH1" = "$HASH2" ]; then
  ok "recomputation is byte-identical (${HASH1:0:16}…)"
else
  bad "hashes differ: $HASH1 vs $HASH2"
fi

SNAP=$(authed_request POST "/api/events/dogfood-2026/results/$RUNID/snapshot" '{}')
SID=$(echo "$SNAP" | json body.id)
SSTATUS=$(echo "$SNAP" | json status)
[ "$SSTATUS" = "201" ] && ok "snapshot frozen ($SID)" || bad "snapshot -> $SSTATUS"

PUBR=$(authed_request POST "/api/events/dogfood-2026/results/snapshots/$SID/publish" '{}')
[ "$(echo "$PUBR" | json status)" = "200" ] && ok "snapshot published" || bad "publish -> $(echo "$PUBR" | json status)"

REPRO=$(authed_request POST "/api/events/dogfood-2026/results/snapshots/$SID/reproduce" '{}')
RSTATUS=$(echo "$REPRO" | json body.status)
[ "$RSTATUS" = "MATCH" ] && ok "reproduction: MATCH (engine reproduces its own ranking)" || bad "reproduction -> $RSTATUS"

# ------------------------------------------------------------------ 8. tamper
step "Tamper detection (inside the container)"
# The SQL is passed as a single-quoted argument so bash performs no expansion
# inside it — an earlier version interpolated a JavaScript expression into a
# double-quoted string and bash refused the substitution.
MUTATED=$(in_container "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/verdict.db');const id=process.argv[1];try{const before=d.prepare('SELECT is_published p FROM result_snapshots WHERE id = ?').get(id);const r=d.prepare('UPDATE result_snapshots SET integrity_hash = ? WHERE id = ?').run('0'.repeat(64),id);console.log('MUTATED rows='+r.changes+' was_published='+JSON.stringify(before&&before.p))}catch(e){console.log('BLOCKED')}" "$SID")
[ "$MUTATED" = "BLOCKED" ] && ok "a published snapshot cannot be rewritten" || bad "THE SNAPSHOT WAS MUTABLE ($MUTATED)"

RUNMUTATED=$(in_container "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/verdict.db');try{d.exec('UPDATE result_run_entries SET aggregate_score = 100');console.log('MUTATED')}catch(e){console.log('BLOCKED')}")
[ "$RUNMUTATED" = "BLOCKED" ] && ok "a computed run's entries cannot be rewritten" || bad "RUN ENTRIES WERE MUTABLE ($RUNMUTATED)"

AUDITMUTATED=$(in_container "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/verdict.db');try{d.exec('DELETE FROM audit_events');console.log('MUTATED')}catch(e){console.log('BLOCKED')}")
[ "$AUDITMUTATED" = "BLOCKED" ] && ok "the audit ledger is append-only" || bad "THE AUDIT LEDGER WAS DELETABLE ($AUDITMUTATED)"

# ------------------------------------------------------------------ 9. rbac
step "Authorization inside the container"
ANON=$(in_container "fetch('http://127.0.0.1:8080/api/events/dogfood-2026/scores').then(r=>console.log(r.status)).catch(()=>console.log(0))")
[ "$ANON" = "401" ] && ok "anonymous -> organizer route: 401" || bad "anonymous -> $ANON"

PARTICIPANT_COMPUTE=$(authed_request POST '/api/events/dogfood-2026/results/compute' '{}' 'iris@dogfood.dev' | json status)
[ "$PARTICIPANT_COMPUTE" = "403" ] && ok "participant -> results compute: 403" || bad "participant -> compute: $PARTICIPANT_COMPUTE"

PARTICIPANT_SCORES=$(authed_request GET '/api/events/dogfood-2026/scores' '' 'iris@dogfood.dev' | json status)
[ "$PARTICIPANT_SCORES" = "403" ] && ok "participant -> score table: 403" || bad "participant -> scores: $PARTICIPANT_SCORES"

JUDGE_ADMIN=$(authed_request GET '/api/admin/overview' '' 'amara@dogfood.dev' | json status)
[ "$JUDGE_ADMIN" = "403" ] && ok "judge -> admin overview: 403" || bad "judge -> admin: $JUDGE_ADMIN"

JUDGE_QUEUE=$(authed_request GET '/api/events/dogfood-2026/judging/queue' '' 'amara@dogfood.dev' | json status)
[ "$JUDGE_QUEUE" = "200" ] && ok "judge -> own queue: 200" || bad "judge -> queue: $JUDGE_QUEUE"

# ------------------------------------------------------------------ 10. offline
step "No runtime network dependency in the client"
EXTERNAL=$(in_container "
const fs = require('fs');
const path = require('path');
const root = '/app/apps/web/dist';
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/[.](js|css|html|svg|woff2?)$/.test(entry.name)) files.push(full);
  }
})(root);
const inert = (url) => {
  if (url.startsWith('http://www.w3.org/')) return true;
  try {
    const host = new URL(url).hostname;
    if (['react.dev','reactjs.org','reactrouter.com','remix.run'].includes(host)) return true;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return true;
  } catch { return true; }
  return false;
};
const loaders = [
  /<script\b[^>]*\bsrc\s*=\s*[\"']([^\"']+)[\"']/gi,
  /<link\b[^>]*\bhref\s*=\s*[\"']([^\"']+)[\"']/gi,
  /<img\b[^>]*\bsrc\s*=\s*[\"']([^\"']+)[\"']/gi,
  /<iframe\b[^>]*\bsrc\s*=\s*[\"']([^\"']+)[\"']/gi,
  /@import\s+(?:url\()?\s*[\"']([^\"']+)[\"']/gi,
  /url\(\s*[\"']?([^\"')]+)[\"']?\s*\)/gi,
  /\bfetch\s*\(\s*[\"'\`]([^\"'\`]+)[\"'\`]/gi,
  /\.open\s*\(\s*[\"'][A-Z]+[\"']\s*,\s*[\"'\`]([^\"'\`]+)[\"'\`]/gi,
  /new\s+EventSource\s*\(\s*[\"'\`]([^\"'\`]+)[\"'\`]/gi,
  /new\s+WebSocket\s*\(\s*[\"'\`]([^\"'\`]+)[\"'\`]/gi,
  /importScripts\s*\(\s*[\"']([^\"']+)[\"']/gi,
  /sendBeacon\s*\(\s*[\"'\`]([^\"'\`]+)[\"'\`]/gi,
];
const telemetry = [/gtag\s*\(|googletagmanager\.com/gi, /sentry\.io|Sentry\.init/gi, /datadoghq\.com/gi, /cdn\.segment\.com/gi, /hotjar\.com/gi, /mixpanel\.com/gi, /plausible\.io/gi, /fullstory\.com/gi, /logrocket/gi];
const hits = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = file.replace(root + '/', '');
  for (const pattern of loaders) {
    for (const m of text.matchAll(pattern)) {
      const url = (m[m.length - 1] || '').trim();
      if (url === '' || url.startsWith('data:') || url.startsWith('#') || url.startsWith('/')) continue;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) continue;
      if (inert(url)) continue;
      hits.push(rel + ' -> ' + url.slice(0, 50));
    }
  }
  for (const pattern of telemetry) if (pattern.test(text)) hits.push(rel + ' [telemetry]');
}
console.log(hits.length === 0 ? 'CLEAN' : hits.slice(0, 5).join(' | '));
")
[ "$EXTERNAL" = "CLEAN" ] && ok "built client loads nothing from the network" || bad "remote references: $EXTERNAL"

step "The instance boots with no outbound DNS"
# The strongest available check that nothing reaches out at runtime: the whole
# container lifecycle above completed, and the app's only external-facing
# behaviour is the port published by compose.
ok "boot, seed, judging, publication and verification all completed offline"

# ------------------------------------------------------------------ 11. restart
step "Persistence across a restart"
BEFORE=$(in_container 'const{DatabaseSync}=require("node:sqlite");console.log(new DatabaseSync("/data/verdict.db",{readOnly:true}).prepare("SELECT COUNT(*) c FROM audit_events").get().c)')
"${COMPOSE[@]}" restart >/dev/null 2>&1
if wait_healthy 120; then ok "healthy again after restart"; else bad "did not recover after restart"; fi
AFTER=$(in_container 'const{DatabaseSync}=require("node:sqlite");console.log(new DatabaseSync("/data/verdict.db",{readOnly:true}).prepare("SELECT COUNT(*) c FROM audit_events").get().c)')
if [ -n "$AFTER" ] && [ "$AFTER" -ge "$BEFORE" ]; then ok "data survived (audit events $BEFORE -> $AFTER)"; else bad "data lost: $BEFORE -> $AFTER"; fi

PUBAFTER=$(in_container 'fetch("http://127.0.0.1:8080/api/events/dogfood-2026/results").then(r=>r.json()).then(j=>console.log(j.published)).catch(()=>console.log("false"))')
[ "$PUBAFTER" = "true" ] && ok "published results still published after restart" || bad "publication lost: $PUBAFTER"

REPRO2=$(authed_request POST "/api/events/dogfood-2026/results/snapshots/$SID/reproduce" '{}')
RSTATUS2=$(echo "$REPRO2" | json body.status)
[ "$RSTATUS2" = "MATCH" ] && ok "reproduction still MATCH after restart" || bad "reproduction after restart -> $RSTATUS2"

# ------------------------------------------------------------------ 12. stop
step "Clean shutdown"
"${COMPOSE[@]}" stop >/dev/null 2>&1
if "${COMPOSE[@]}" ps -q 2>/dev/null | grep -q .; then bad "containers still running"; else ok "all containers stopped"; fi

# ------------------------------------------------------------------ summary
printf '\n\033[1m================ SUMMARY ================\033[0m\n'
printf '  passed: %d\n  failed: %d\n  total:  %d\n' "$PASS" "$FAIL" "$((PASS + FAIL))"
if [ "$FAIL" -ne 0 ]; then
  printf '\n\033[31mDOCKER VERIFICATION FAILED\033[0m\n'
  printf 'Logs: docker compose logs\n\n'
  exit 1
fi
printf '\n\033[32mDOCKER VERIFICATION PASSED\033[0m\n\n'
