# Verdict

Hackathon operations with a judging engine you can audit.

Most hackathon results are not disputed because anyone is wrong. They are
disputed because nothing about the process was checkable: the rubric was
described after the fact, nobody could say which judge scored which project, one
judge's generosity moved three places, and the person who lost had no way to
tell whether the outcome was carelessness or a decision.

Verdict is built around making the result *arguable*. The rubric is published
before judging opens. Conflicts are declared and enforced by the assignment
engine rather than remembered by everyone. Judges differ in generosity, so their
scores are normalized per judge before anything is aggregated. And every
published result is a frozen snapshot with an integrity hash that anyone can
recompute from the stored reviews — the engine has to reproduce its own output,
or verification says so.

It is a self-hosted, single-binary-and-a-SQLite-file platform. It works on an
air-gapped machine. There is no cloud service to sign up for.

---

## Quick start

```bash
cp .env.example .env
# SESSION_SECRET is the only value with no default. Generate one:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# paste it into .env, then:
docker compose up --build
```

Open <http://localhost:8080>. A demo event is seeded on first boot, so there is
something to click immediately. Every demo account shares the password
`verdict-demo-2026`:

| Role | Email | What it shows |
| --- | --- | --- |
| Admin | `admin@hackathonraptors.dev` | Platform-wide control |
| Organizer | `organizer@dogfood.dev` | Coverage, score table, compute/snapshot/publish/verify |
| Judge (generous) | `amara@dogfood.dev` | A full judging queue |
| Judge (harsh) | `ben@dogfood.dev` | The same projects scored low |
| Judge (low variance) | `priya@dogfood.dev` | Tight clustering |
| Judge (broad spread) | `tomas@dogfood.dev` | Innovation-weighted, wide spread |
| Judge (2 unfinished) | `yuki@dogfood.dev` | Drafts that make the coverage report honest |
| Participant | `iris@dogfood.dev` | The participant view |

The judges are deliberately different from each other. Two of them are set up so
normalization has something to do, and one leaves reviews unfinished so the
coverage report is not a row of green ticks.

### Without Docker

Node 22.6 or newer is the only requirement — the platform uses Node's built-in
TypeScript execution and its built-in SQLite, so there is no build step for the
server and nothing to compile.

```bash
npm install
npm run build          # builds the web client
npm start              # migrates, seeds on first run, serves on :8080
```

`npm run dev` runs the API and the Vite dev server together; the dev server
proxies `/api`, so cookies stay same-origin and the real CSRF path is exercised.

---

## What is here

```
packages/core     the judging engine: pure functions, no I/O, no framework
apps/api          Fastify API, SQLite storage, RBAC, audit ledger, seed data
apps/web          React client served by the API in production
scripts           OpenAPI export and the acceptance harness
```

The split is load-bearing. Everything that decides a score lives in
`packages/core` and takes its inputs as arguments, so the mathematics can be
tested without a database, a server, or a clock. The API is responsible for
authorship, authorization, persistence and audit — and for calling the core with
the right inputs.

### The judging pipeline

1. **Rubric.** Criteria with weights summing to 1, published before judging
   opens. A rubric version is immutable once scores exist against it.
2. **Assignment.** Judges are matched to projects by strategy
   (`RANDOM`, `BALANCED`, `CONFLICT_AWARE`, `WORKLOAD_AWARE`,
   `PANEL_DIVERSITY`). Declared hard conflicts are never assigned under any
   strategy. Overriding one is possible, and requires a written reason that
   lands in the audit ledger.
3. **Scoring.** Judges see only their assigned projects. No endpoint returns
   another judge's scores, so blind judging is a property of the API rather than
   a filter in the browser.
4. **Normalization.** Judges differ in generosity, which is a property of people
   rather than of projects. Scores are normalized per judge before aggregation.
   The method is chosen explicitly and recorded in the run.
5. **Aggregation.** Criterion scores combine by weight; a project's criteria
   combine by the chosen method, with tie groups and coverage flags.
6. **Snapshot.** A computed run is frozen into a sequenced, append-only
   snapshot. Corrections publish a *new* snapshot; the database refuses to let a
   published one be edited or deleted.
7. **Verification.** Recompute the pipeline from the stored reviews. If it no
   longer produces the published ranking, verification reports the difference.

`docs/JUDGING.md` explains the mathematics and why each default was chosen.
`docs/ARCHITECTURE.md` covers the storage and authorization model.

### Reproducibility

Every result run carries an `inputHash` over the exact reviews, rubric,
assignment version, normalization and aggregation settings that produced it, and
an `integrityHash` over the ranking that came out. Recomputing from the same
inputs produces the same hashes — there is no clock, no random number
generator, and no iteration order that depends on a hash table in the result
path.

Verify any published result:

```bash
curl -s localhost:8080/api/events/dogfood-2026/results | jq '.snapshot.integrityHash'
```

Then, as an organizer, `POST /api/events/{eventId}/results/snapshots/{id}/reproduce`
and compare.

---

## Operations

### Migrations

Migrations are immutable and transactional. Editing an applied migration is
refused with a checksum mismatch; add a new one instead.

```bash
npm run migrate
```

They run automatically on boot unless `AUTO_MIGRATE=false`.

### Configuration

Every setting is an environment variable with a working default, except
`SESSION_SECRET`. `.env.example` documents the lot. The two that will bite you
if ignored:

- `SESSION_SECRET` — required in production. Rotating it signs everyone out.
- `SESSION_SECURE_COOKIES` — set to `true` as soon as you serve over https.

### Backups

Everything is in the database file and the uploads directory, both under
`/data`. For a consistent copy, use SQLite's own backup rather than `cp`, which
can capture a torn write:

```bash
docker compose exec verdict node -e "
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync('/data/verdict.db').exec(\"VACUUM INTO '/data/backup.db'\");
"
docker compose cp verdict:/data/backup.db ./verdict-backup.db
```

### Behind a reverse proxy

Set `TRUST_PROXY=true` — but only if a proxy you control is actually in front.
With it on and nothing rewriting `X-Forwarded-For`, a client can spoof its own
IP address and defeat per-IP rate limiting.

The app does not terminate TLS. Put it behind Caddy, nginx, or a load balancer
that does.

### Scaling

Do not run two containers against one SQLite file. The whole integrity story
rests on a single writer with WAL and foreign keys enforced; a second writer
means lock contention at best and a misleading audit trail at worst. One
container is comfortably enough for a hackathon: the seeded demo event, with
34 reviews and a full result pipeline, boots and serves in under a second.

---

## Security posture

What is implemented, and where to check it:

- **Passwords** — scrypt (N=32768, r=8, p=1), per-password salt, constant-time
  verification. A sign-in for an unknown address performs a dummy verification
  so the endpoint cannot be used to enumerate accounts, and eight consecutive
  failures lock an account for fifteen minutes.
- **Sessions** — opaque random tokens; only a SHA-256 digest is stored, so a
  database leak does not hand anyone live cookies. The session cookie is
  `HttpOnly` and `SameSite=Lax`; idle and absolute timeouts are both enforced
  server-side.
- **CSRF** — double-submit token plus an origin check on every mutating request,
  applied globally rather than per route.
- **Authorization** — one declarative matrix in `apps/api/src/lib/rbac.ts`. No
  route decides permission for itself; they state the facts they established
  (owner, assigned judge, team member, organizer of this event) and the matrix
  decides. Anonymous is 401, authenticated-but-refused is 403.
- **Audit** — append-only, enforced by database triggers rather than
  convention. Denials are recorded too, so "nobody tried that" is a claim the
  ledger can support.
- **Uploads** — magic-byte sniffing, size caps, SHA-256 recorded at upload and
  re-verified before serving, `nosniff` and an explicit disposition.
- **Webhooks** — SSRF protection: private and link-local addresses are refused
  unless explicitly allowed, redirects are not followed blindly, and deliveries
  are signed.
- **Rate limiting** — keyed on the account where one is identified, because a
  per-IP limit is trivially evaded and punishes shared NAT.

The test suite asserts these, and several of the tests are named after bugs that
were found and fixed during development. See `apps/api/test/security.test.ts`.

---

## Development

```bash
npm run typecheck      # both the node and the browser project
npm test               # 269 tests
npm run test:core      # the judging engine alone
npm run test:api       # API, security, static serving
npm run build          # the web client
npm run openapi        # export openapi.json from the Zod schemas
npm run check:openapi  # fail if openapi.json is stale
npm run verify         # typecheck, test, build, acceptance
```

The API documentation is generated from the same Zod schemas that validate
requests at runtime, so it cannot drift from the implementation. It is served at
`/api/docs` and exported as `/api/openapi.json`.

### Testing approach

`packages/core` is tested as pure functions with injected clocks and seeded
randomness — no database, no server, no sleeping. The API is tested through the
real Fastify instance with `app.inject` against a real SQLite file on disk, so
migrations, `STRICT` tables, foreign keys, `CHECK` constraints and triggers are
all genuinely exercised. Nothing important is mocked.

---

## License

Apache-2.0.
