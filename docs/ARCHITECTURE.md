# Architecture

## The shape of the thing

```
┌──────────────────────────────────────────────────────────────┐
│  apps/web            React SPA, served by the API in prod    │
│  ────────────────────────────────────────────────────────────│
│  apps/api/src/http   Fastify: routes, middleware, envelope   │
│  apps/api/src/services   domain services, authorization      │
│  apps/api/src/db        SQLite, migrations, triggers         │
│  ────────────────────────────────────────────────────────────│
│  packages/core      judging mathematics. Pure. No I/O.      │
└──────────────────────────────────────────────────────────────┘
```

The important boundary is the last one. Everything that decides a score is a
pure function over explicit inputs in `packages/core`. It has no database, no
clock, no random number generator, and no knowledge of HTTP. That is what makes
the engine testable in isolation and reproducible in production — a result run
can be recomputed from stored inputs years later, by a different build, and come
out identical.

`apps/api` owns authorship, authorization, persistence and audit. It gathers
inputs, calls the core, and records what it did.

## Request lifecycle

`apps/api/src/http/app.ts` assembles the app in a fixed order, and the order is
load-bearing:

1. **Request id** — every request gets one, so a user-visible error reference
   can be found in the logs and the audit ledger.
2. **Security headers** — before anything can produce a response.
3. **Body limits** — before a handler can read an enormous body.
4. **Context** — resolves the session, the actor, and their roles.
5. **Rate limiting** — *after* identity, so it can key on the account.
6. **CSRF and origin check** — globally, never per route.
7. **Routes**.
8. **Error rendering** — last, so it catches everything above.

Rate limiting is hand-written rather than delegated to `@fastify/rate-limit`. The
plugin's default rejection path *throws*, which the error handler then renders as
a 500 — so a rate-limited request was being reported as a server fault, and
during a live event that is an alert that means nothing. The bundled
implementation keys on the account when one is identified and answers 429
directly.

## Authorization

There is exactly one place permission is decided:
`apps/api/src/lib/rbac.ts`. It is a declarative matrix of
`role → action → resource → scope`, where scope is one of `PUBLIC`, `OWN`,
`ASSIGNED`, `EVENT`, `ANY`.

A route never decides for itself. It states the facts it established:

```ts
requirePermission(services, ctx, 'submission', 'update', {
  ownerId: submission.created_by,
  teamMember: membership !== null,
  inOrganizedEvent: canManageEvent(ctx.actor, eventId),
});
```

and the matrix answers. Two consequences worth having:

- A route cannot accidentally leak a field, because leaking requires granting a
  scope the route did not establish.
- The matrix is readable in one sitting, and `describeMatrix()` renders it into
  the API documentation.

Anonymous is `401`, authenticated-but-refused is `403`. Keeping those apart is not
cosmetic: clients send people to sign in on the first and show an error on the
second. Collapsing them makes an expired session look like a permissions problem.

## Storage

SQLite via Node's built-in `node:sqlite`. Not a compromise for a small
deployment — it is the right tool here, because the properties that matter here
are properties of SQLite:

- **`STRICT` tables** everywhere, so a string cannot land in a numeric column.
- **Foreign keys enforced** (`PRAGMA foreign_keys = ON`), not merely declared.
- **`CHECK` constraints** as the last line of defence against a bad write.
- **Triggers** making append-only tables actually append-only, at the storage
  level rather than by convention.
- **WAL** for concurrent reads alongside a single writer.
- **Transactions** with savepoints, so a partial event creation cannot survive.

The schema is 45 tables across 14 migrations. Migrations are immutable: an
applied migration whose contents changed is refused with a checksum mismatch,
because a schema that silently drifts under a live event is worse than a failed
deploy.

### Results: runs and snapshots are different things

A **result run** is a computation. A **result snapshot** is a publication of one.
They are separate tables — `result_runs` with `result_run_entries`, and
`result_snapshots` with `result_entries` — because:

- Several snapshots may point at one run. A correction re-publishes; it does not
  recompute.
- A run must be rehydratable and verifiable long before anyone publishes it.
- The run's entries are the source of truth; a snapshot is a frozen copy.

Storing entries only under a snapshot makes all three impossible: creating a
snapshot has to read the entries it is about to write, and rehydrating an
unpublished run returns nothing, so verification compares nothing against
something and can never succeed.

Published snapshots are immutable in the database, not just in the application.
A correction is a new snapshot with a `supersedes_id`.

### Roles and scope

`user_roles` is the one table where a nullable column is part of a key, which
SQLite will not allow directly: in a `STRICT` table a primary-key column is
implicitly `NOT NULL`, so a global role (`ADMIN`, `PARTICIPANT`) with no event
could not be stored at all.

The fix is a non-null `scope` column mirroring `event_id` with `NULL` collapsed
to `''`, with a `CHECK` that keeps the two from drifting apart. `event_id` keeps
its foreign key — SQLite skips the check for `NULL`, so a global role is simply
unreferenced while an event-scoped role is genuinely validated.

## Sessions

Opaque random tokens. The database stores only a SHA-256 digest, so a leaked
database file does not hand an attacker live session cookies. The session cookie
is `HttpOnly` — stated explicitly rather than inherited from a library default,
because `@fastify/cookie` applies no default for it and relying on that would
have shipped a credential any script on the page could read.

CSRF is double-submit plus an origin check. The CSRF token is in a deliberately
readable cookie, because the browser is the only thing that can echo it back in
a header; it is useless without the session cookie, which the browser attaches
on its own.

## The audit ledger

Append-only, enforced by triggers. Every state change records who, what, when,
from which state to which state, and the request id that correlates it with the
HTTP log line.

Denials are recorded as well as successes. "Nobody attempted to read that
judge's scores" should be a claim the ledger can support, not one a participant
has to take on trust.

## Failure modes considered

- **Migration edited after being applied** — refused by checksum.
- **Two writers** — the reason the deployment is documented as single-container.
  A second writer means lock contention at best and a misleading audit trail at
  worst.
- **Clock skew** — nothing in the result path reads the clock. Timestamps are
  recorded; they do not influence a score.
- **Backups taken with `cp`** — can capture a torn write. The README documents
  `VACUUM INTO` instead.
- **A judge's browser dies mid-review** — drafts save as they type.
- **A judge's last review is late or missing** — the coverage report names the
  project, and the result publishes with the shortfall stated rather than
  silently dropping it.
- **Two judges with irreconcilable scoring styles** — normalization handles the
  generosity difference; the spread is reported per project so a genuine
  disagreement is visible instead of being averaged away.
