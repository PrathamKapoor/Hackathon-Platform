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

**Not executed: Docker.** Neither `docker` nor `docker compose` is installed in
the environment this was verified in. The image and compose file were reviewed
statically and their settings corrected, but no image was built and no container
was run. This is stated as **NOT EXECUTED — Docker unavailable** and is not
claimed anywhere as working.

Everything else below was run, and the counts are what the commands actually
printed.

---

## Commands run, and what they printed

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass. Both projects: core/api/tests/scripts, then the web app. |
| `npm test` | **441 passed**, 0 failed, 70 suites. |
| `npm run build` | Pass. 505.46 kB JS, 146.44 kB gzipped, 16.66 kB CSS. |
| `npm run test:e2e` | **50 passed**, 0 failed, 8 suites, real Chrome against the built bundle. |
| `npm run acceptance` | **35 of 35 checks passed.** |
| `npm run check:openapi` | Up to date. 144 operations across 123 paths. |
| `npm run verify` | All of the above, in order, green. |
| `docker build` / `docker compose up` | **NOT EXECUTED — Docker unavailable.** |
| Multi-viewport browser check | 4 viewports × 10 surfaces, as part of `test:e2e`. |
| Clean-database migration + seed | Covered by every test harness; each boots a fresh database. |
| Old-schema upgrade (v11 → v15) | Covered by `migrations.test.ts`. |
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
| Single-command self-hosting | **Static review only** | `docker compose up` with **no `.env` file required**. The compose file supplies a public local-only session secret so the command works on a fresh clone; both the compose file and the README say in capitals that this is not a production secret and must be overridden. **NOT EXECUTED — Docker unavailable.** |
| Health check that means something | Met (static) | `/api/ready`, not `/api/health`; reviewed, not run. |
| Graceful shutdown | Met (static) | `tini` as PID 1, 20 s stop grace, app drains with its own 10 s timer. |
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
| Test suite | Met | 441 unit/integration, 50 browser, 35 acceptance. |

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

---

## Known limitations

Stated rather than hidden. None is a surprise; all are recorded in the docs.

**Deployment**
- **Docker was never executed.** No image build, no container run, no compose
  verification. The files were reviewed and corrected statically.
- No signed images, no image pinning to a digest, and the base image tag
  (`node:24-bookworm-slim`) floats.

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

- [x] `npm run verify` green: typecheck, 441 unit/integration, build, 50 browser, 35 acceptance
- [x] OpenAPI document current, and checked against a live server on every test run
- [x] Result pipeline deterministic and reproducible, verified from stored reviews
- [x] Published results immutable, corrections supersede rather than rewrite
- [x] Role boundaries enforced server-side, not only hidden in the UI
- [x] Audit ledger append-only, enforced by triggers
- [x] No dead advertised features: every webhook topic fires, every route serves, every declared export and import kind works, every panel is real
- [x] Voting cannot leak into the result it informs; participants may correct a vote
- [x] Reads do not write
- [x] Responsive and accessible at 390 / 768 / 1280 / 1440
- [x] Migration from an older release tested with data intact (v11 → v15)
- [x] Backup and restore tested end to end, including result reproduction
- [x] `docker compose up` needs no `.env`; Apache-2.0 `LICENSE` present and asserted by test
- [x] Documentation complete: architecture, judging, data model, API, threat model, development, operations
- [ ] Docker image and compose stack actually built and run — **NOT EXECUTED, Docker unavailable in this environment**
- [ ] **Restore from a production backup** — tested procedurally, not against production data
- [x] No secrets, credentials or `.env` committed
- [x] All commits authored and committed by the repository owner alone
