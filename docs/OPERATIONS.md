# Operations

Running Verdict for a real event: deploying it, backing it up, upgrading it, and
knowing what to do when something is wrong.

The whole system is **one container and one SQLite file**. That is the design
constraint that makes it self-hostable on a laptop, and it is also the thing to
respect: one container, one volume, one database file, one writer.

---

## Deploying

### For a look at it

```bash
docker compose up --build
```

That is the whole command. **No `.env` file is required**, and that used to be a
lie: the instructions said "copy `.env.example` to `.env` first" but the
repository shipped neither a working default nor an enforced step, so a fresh
clone failed to start. The compose file now supplies every value itself, so the
single-command claim is true.

**The `SESSION_SECRET` in `docker-compose.yml` is a published constant, in
capitals, in the file.** It is there so a first `docker compose up` works and a
demo can be handed to somebody. It is not a secret, because it is in a public
repository. It is fine for evaluating the system on a laptop and **must be
overridden for anything else**.

### For a real event

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# put it in .env as SESSION_SECRET, then:
docker compose up --build
```

Set `AUTO_SEED=false` as well, or the stack comes up with the demo dataset
loaded. It serves `http://localhost:8080`.

Outside the compose file, `SESSION_SECRET` has **no default** and a missing or
too-short one is a fatal boot error rather than a warning. The alternative is a
per-boot random secret that signs every user out on every deploy - and an
organizer mid-event will not forgive it. Set it once, keep it.
**Rotating it signs everyone out and invalidates salted vote IP hashes.**

To override the compose default without editing the file, set `SESSION_SECRET` in
the environment before `docker compose up`, or put it in a `.env` beside the
compose file - compose reads one automatically and its values take precedence
over the ones written in the service block.

### The image

Two stages on `node:24-bookworm-slim`. The build stage installs, compiles the
SPA and prunes dev dependencies; the runtime stage carries the built bundle, the
API and the pruned tree, runs as the non-root `node` user, and starts under
`tini` as PID 1 so `SIGTERM` is delivered to Node rather than swallowed by PID 1.
`/data` is declared as a volume and is the only writable location the app needs.

### The health check uses `/api/ready`, not `/api/health`

`/api/health` returns 200 even with a corrupt database, which is right for
liveness and wrong for orchestration: a container that cannot query its own data
would be reported healthy, never restarted, and would keep receiving traffic.
`/api/ready` returns 503 until migrations have run and the database answers.

Shutdown gets 20 seconds of grace, and the app has its own 10-second force-exit
timer. Docker's default 10-second stop grace equals that exactly, so the two
race and the container is usually `SIGKILL`ed mid-checkpoint.

### Two things to change before a real event

```bash
AUTO_SEED=false            # do not create accounts with a published password
SESSION_SECURE_COOKIES=true # the moment you serve over https
```

`AUTO_SEED=true` is convenient for a first run and a screenshot, and wrong for a
real event: it creates 40-odd accounts that all share the password
`verdict-demo-2026`.

### Configuration

`.env.example` is the annotated reference. The values worth deciding rather than
accepting:

| Variable | Default | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | none in the app; a **published demo constant** in `docker-compose.yml` | Required in production. 32+ characters. The compose default exists so `docker compose up` works with no `.env`; it is public and must be overridden for a real event. |
| `PUBLIC_URL` | `http://localhost:8080` | Used for links, and decides the Origin check. |
| `AUTO_SEED` | `true` (non-test) | **Set false for a real event.** |
| `AUTO_MIGRATE` | `true` | Migrations are transactional and refuse to run if an applied one was edited. |
| `SESSION_SECURE_COOKIES` | `true` in production | Turn on for any https deployment. |
| `TRUST_PROXY` | `false` | **Only** behind a proxy you control - see below. |
| `ALLOW_PRIVATE_WEBHOOK_TARGETS` | `false` | Keep false. It hands webhook creators a way into your network. |
| `SESSION_IDLE_TIMEOUT_DAYS` | 14 | An active judge's session does not expire mid-event. |
| `REVIEWS_PER_PROJECT` | 3 | Event default; overridable per event. |

`TRUST_PROXY` is the one that bites. With it on and no proxy in front, a client
can spoof `X-Forwarded-For` and walk straight through a per-IP rate limit.

### Network reality

**The runtime needs no network at all.** No CDN, no external fonts, no analytics,
no cloud service, no outbound calls except webhook deliveries the organizer
configured. The Grainient background is a local dependency.

**The build does.** `docker compose up --build` needs the network to fetch the
base image, `npm ci` and `apt-get`. On an air-gapped machine, build elsewhere and
load the image:

```bash
docker save verdict:local -o verdict.tar
# on the target
docker load -i verdict.tar
docker compose up -d
```

---

## Backup

**`VACUUM INTO` is the backup command.** Not `cp`.

```bash
docker exec verdict node -e "
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync('/data/verdict.db');
  db.exec(\"VACUUM INTO '/data/backup-$(date +%F).sqlite'\");
  db.close();
"
```

`VACUUM INTO` takes a consistent snapshot without stopping the writer and
without the truncation hazard of copying the file while SQLite has it open. A
`cp` of a WAL-mode database can capture the `.db` without the matching `-wal`
and produce a file that is short of recent transactions.

**Back up the uploads directory too.** It is separate from the database and not
recoverable from it.

```bash
docker run --rm -v verdict-data:/data -v "$PWD:/out" alpine \
  tar czf /out/uploads-$(date +%F).tar.gz -C /data uploads
```

### Verify the backup, every time

A backup nobody has restored is a hypothesis. This is tested - see
`apps/api/test/migrations.test.ts` - and it is the check that matters:

```bash
node -e "
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync('backup-2026-02-04.sqlite');
  console.log('pages:  ', db.prepare('PRAGMA integrity_check').get());
  console.log('keys:   ', db.prepare('PRAGMA foreign_key_check').all());
  console.log('runs:   ', db.prepare('SELECT COUNT(*) c FROM result_runs').get());
  db.close();
"
```

`integrity_check` should print `ok` and `foreign_key_check` should print `[]`.
Then boot the application on the copy and reproduce the published result: the
integrity hash in the restored database must match the one in the live one. That
is the property that makes a backup worth having, and a row count does not prove
it.

### A schedule that is actually defensible

Before the event starts, and again after results are published. Between those
two points the database is being written to constantly and a snapshot from
yesterday is not a useful answer to "what did the judges submit".

---

## Restore

```bash
docker compose down
docker run --rm -v verdict-data:/data alpine sh -c 'rm -f /data/*.sqlite*'
docker run --rm -v verdict-data:/data -v "$PWD:/backup" alpine \
  cp /backup/backup-2026-02-04.sqlite /data/verdict.db
# uploads, if you have them
docker compose up -d
docker compose logs -f verdict
```

Then check `GET /api/ready`, sign in as an organizer, and reproduce the published
result. If the integrity hash matches what was published, the restore is
complete; if it does not, the backup is not the database you thought it was.

---

## Upgrading

```bash
git pull
docker compose up --build
```

`AUTO_MIGRATE=true` applies pending migrations on boot. Each is transactional:
it either applies completely or not at all, and a failure rolls back and aborts
the boot with the migration number and the reason.

**Migrations are immutable.** Editing an applied one is refused at boot with a
checksum mismatch, because a database that had the old version applied would
silently diverge from the code. If you need a schema change, add version 15.

To apply them as a separate, observable step - which is what you want before an
event, so a failure is a non-event rather than a failed boot:

```bash
docker compose run --rm verdict node apps/api/src/db/migrate-cli.ts
```

It prints the versions applied and then runs `PRAGMA foreign_key_check`,
reporting any violation and exiting non-zero. **Read that output.** A violation
here is almost always a row that an older, laxer schema allowed and the current
one would refuse - `user_roles.event_id` gained a foreign key in version 13 and
was never enforced before. It is a data problem to look at, not a reason to
refuse to start, which is why the check is in the migrate step rather than in the
boot path.

**Take a backup first.** There is no downgrade path, and none is intended.

---

## Monitoring

Structured JSON logs, one object per line, unless `LOG_PRETTY=true`. Levels:
`debug`, `info`, `warn`, `error`, `silent`. Passwords, session cookies, CSRF
tokens, reset tokens and webhook secrets are redacted before they reach a log
line.

| Endpoint | Use |
| --- | --- |
| `GET /api/health` | Liveness. 200 even with a degraded database. Not rate limited, so it is safe to poll. |
| `GET /api/ready` | Readiness. 503 until migrations have run and the database answers. |
| `GET /api/events/{eventId}/diagnostics` | Panel health: coverage, per-judge spread, review signals. **A GET that persists review flags** - it is deliberately not a POST because a GET that silently writes is a trap for link previews, but it does mean fetching the link writes. |
| `GET /api/events/{eventId}/audit` | The audit ledger, with a chain digest. |

For a live event, the three numbers worth watching are judging coverage (how many
projects are short of their target review count), the spread of judge mean
scores, and whether webhook deliveries are failing. All three are in Diagnostics
and the Integrations panel.

There is **no metrics endpoint**. If you need Prometheus-style metrics, scrape
`/api/ready` and the logs, or put a proxy in front that exports them.

---

## Recovery

**A judge submitted a review they want to change.** The review is read-only once
submitted. An organizer override exists and is written to the audit ledger with
`resourceType: 'score'` - the trace of who changed what, and when, is the point.

**A result was published and is wrong.** Do not edit it. A published snapshot and
its entries are immutable at the database level. Publish a correction: a new
snapshot that supersedes the old one, with a written reason. Both remain, and the
superseded one is still verifiable.

**Someone suspects tampering with the result.** `POST
/api/events/{eventId}/results/snapshots/{id}/reproduce` recomputes the run from
the stored reviews and reports `MATCH` or a per-project diff. It is also called
automatically before every publish, so a result that cannot reproduce is not
publishable. `GET /api/results/verify/{reference}` is public and needs no
account, so a losing team can check it themselves.

**A webhook receiver stopped working.** The delivery list shows status, response
body, error and attempt count, with backoff at 30s, 60s, 120s, 240s. After five
consecutive failures the webhook is disabled and the failure is audited, so it
cannot silently keep retrying forever. Fix the receiver, then use
`POST /api/webhooks/deliveries/{deliveryId}/redeliver` to replay it.

**A judge's account is locked out.** 8 failures locks it for 15 minutes. An
admin can clear it with `POST /api/admin/users/{userId}/state`. Suspending
instead revokes every session the account has.

**The container will not become healthy.** In order: is `SESSION_SECRET` set and
32+ characters (a missing one is a *boot* error, so the container will be
restarting, not unhealthy); did `AUTO_MIGRATE` fail - run the migrate CLI by hand
and read its output; is the volume writable by uid 1000, which is the `node` user
the image runs as; is `PUBLIC_URL` https while `SESSION_SECURE_COOKIES` is true,
which means the cookie is never sent back.

**The database file looks corrupt.** Do not start the app on it. Take a copy,
run `PRAGMA integrity_check` on the copy, and try restoring the last good backup.
`/api/health` deliberately reports `degraded` in this situation rather than
failing, so the container stays up and inspectable.

---

## Capacity

Measured on the seeded demo - 12 projects, 12 teams, 36 assignments, 24 users -
on one modern x86 core:

| Operation | Time |
| --- | --- |
| Cold boot: migrate an empty database, then seed | ~330 ms |
| Public gallery | ~8 ms |
| Judging queue | ~3 ms |
| Full pipeline: normalize, aggregate, rank, diagnose, hash | ~14 ms |
| Reproduce a published result | ~8 ms |

These are on a dataset two orders of magnitude smaller than a large event, so
they say the implementation has no accidental blow-up rather than promising
figures for 200 projects. The regression guard in
`apps/api/test/migrations.test.ts` asserts loose upper bounds (30 s boot, 3 s
gallery and queue, 20 s compute and reproduce) and logs the real numbers, so a
dropped index that turns a lookup into a table scan shows up as a failed bound
rather than as a slow afternoon.

SQLite in WAL mode with `synchronous=NORMAL` is comfortable well past what a
hackathon generates. The limit is the single writer, and there is only one
process.

---

## Scaling, honestly

**Do not run two instances against one database file.** They will not corrupt it -
WAL locking prevents that - but the two instances will each keep their own
in-process rate-limit counters, so every client gets twice the budget, and
webhook retries will be attempted by both. The session secret makes the cookies
portable; the rate limiter does not.

To run more than one, you need a shared limiter store and a decision about which
instance owns webhook retries. Neither exists. One container is a supported
configuration and is the right answer for an event.

**Reverse proxy.** Put one in front for TLS, request logging and a second factor.
Then set `TRUST_PROXY=true` - and only then.
