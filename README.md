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
git clone https://github.com/PrathamKapoor/Hackathon-Platform.git
cd Hackathon-Platform
docker compose up
```

That is the whole setup. No `.env` to copy, no secret to generate, no account to
create, no external service, and no network needed once the image is built. Open
<http://localhost:8080> — a demo event is seeded on first boot, so there is
something to click immediately.

> **The bundled `SESSION_SECRET` is for local and demo use only.** It is in
> `docker-compose.yml` in plain text on purpose, because its entire job is to let
> someone start a demo. **A real deployment must override it** — put a value in
> `.env` or the environment and compose will prefer it. The application itself is
> unchanged: `NODE_ENV=production` with a missing or short secret is still a
> fatal boot error, so nothing here weakens production. See
> [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

Every demo account shares the password `verdict-demo-2026`:

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

To reset to a clean slate, including the demo data:

```bash
docker compose down -v && docker compose up
```

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

Every setting is an environment variable with a working default.
`.env.example` documents the lot. `SESSION_SECRET` is the one the application
refuses to invent in production — but `docker compose` supplies a demo default
so a fresh clone starts; override it for anything real.

- `SESSION_SECRET` — **override the bundled demo value for any real
  deployment.** Rotating it signs everyone out and invalidates salted vote-IP
  hashes.
- `SESSION_SECURE_COOKIES` — set to `true` as soon as you serve over https.
- `AUTO_SEED` — the demo accounts share a published password. Set it to `false`
  for a real event.

### Backups

Everything is in the database file and the uploads directory, both under
`/data`. For a consistent copy, use SQLite's own backup rather than `cp`, which
can capture a torn write against a WAL-mode database:

```bash
docker compose exec verdict node -e "
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync('/data/verdict.db').exec(\"VACUUM INTO '/data/backup.db'\");
"
docker compose cp verdict:/data/backup.db ./verdict-backup.db
```

Back up the uploads directory too — it is separate from the database and not
recoverable from it. And **check the restore**: `PRAGMA integrity_check` on the
copy, then boot the application on it and confirm the published result still
reproduces the same integrity hash. A backup nobody has restored is a
hypothesis. `docs/OPERATIONS.md` has the full procedure, including the restore
steps and an automated test that does exactly this check.

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
  decides. An anonymous caller is 401 and a refused one is 403 — though most
  handlers resolve the record before checking, so a caller with a well-formed but
  nonexistent id gets 404 first. Clients should not read 401 as a guarantee.
- **Audit** — append-only, enforced by database triggers rather than
  convention. Denials are recorded too, so "nobody tried that" is a claim the
  ledger can support.
- **Content-Security-Policy** — applied to every response, with `script-src
  'self'` and no `unsafe-inline` for scripts. This is the header that contains a
  stored XSS on a page rendering participant-submitted text, and it used to be
  absent entirely: the policy was disabled in Fastify with a comment claiming the
  static handler set a real one, and the static handler set none.
- **Uploads** — magic-byte sniffing, size caps, SHA-256 recorded at upload and
  re-verified before serving, `nosniff` and an explicit disposition. SVG is
  refused outright.
- **Webhooks** — SSRF protection: private and link-local addresses are refused
  unless explicitly allowed, the hostname is re-resolved and re-checked before
  every delivery, redirects are not followed, and deliveries are signed with the
  timestamp inside the signed material.
- **Rate limiting** — keyed on the account where one is identified, because a
  per-IP limit is trivially evaded and punishes shared NAT. `TRUST_PROXY` defaults
  to off, so a client cannot spoof its way past it.

The test suite asserts these, and several of the tests are named after bugs that
were found and fixed during development. `docs/THREAT-MODEL.md` records what is
left over — no MFA, no encryption at rest, an in-process rate limiter, and an
audit ledger that is append-only to the database but not tamper-evident against
an operator with the file.

---

## Development

```bash
npm run typecheck      # both the node and the browser project
npm test               # 382 unit and integration tests
npm run test:core      # the judging engine alone
npm run test:api       # API, security, migrations, static serving
npm run test:e2e       # builds, then 45 browser tests
npm run build          # the web client
npm run openapi        # export openapi.json from the route registry
npm run check:openapi  # fail if openapi.json is stale
npm run acceptance     # 35-check release harness
npm run verify         # typecheck, test, build, e2e, acceptance
```

The API documentation is generated from the route registry, and served live at
`/api/docs` and `/api/openapi.json`. It is checked in CI, so it cannot fall
silently behind the implementation — but it is not a perfect description of it,
and the gaps are listed rather than glossed: success statuses, query parameters
and the `requestId` header in the published document are all known to be wrong or
incomplete. See the closing section of `docs/API.md` before treating it as
authoritative.

### Documentation

| | |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Request lifecycle, storage model, failure modes considered. |
| [`docs/JUDGING.md`](docs/JUDGING.md) | The mathematics: normalization, aggregation, pairwise, diagnostics. |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | Every table, what the schema guarantees, and where it can drift. |
| [`docs/API.md`](docs/API.md) | Conventions, error codes, all 140 operations, known spec defects. |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) | Assets, trust boundaries, mitigations, and what is left over. |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Layout, commands, testing, conventions. |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Deploy, back up, restore, upgrade, recover, capacity. |
| [`docs/ACCEPTANCE-REPORT.md`](docs/ACCEPTANCE-REPORT.md) | What was verified, what was fixed, and what is still open. |

### Testing approach

`packages/core` is tested as pure functions with injected clocks and seeded
randomness — no database, no server, no sleeping. The API is tested through the
real Fastify instance with `app.inject` against a real SQLite file on disk, so
migrations, `STRICT` tables, foreign keys, `CHECK` constraints and triggers are
all genuinely exercised. Nothing important is mocked.

---

## License

[Apache-2.0](LICENSE) — the full text is in `LICENSE`.
