# Development

Node **22.6 or newer** (`engines.node`). Developed and verified on 24.x. No global
tooling: the only dev dependencies are TypeScript, Playwright and esbuild's
postinstall.

```bash
npm install
npm run dev
```

That runs the API on `http://127.0.0.1:8080` and Vite on
`http://127.0.0.1:5173`. **Use the Vite URL**, not the API URL, for anything with
a UI - Vite proxies `/api` to the API process, so there is one origin, cookies
stay same-origin, and the dev setup exercises the real CSRF and cookie path
rather than a special-case one.

The first boot migrates an empty database and seeds the demo dataset, so there is
something to click. Every demo account uses the password `verdict-demo-2026`
(see the README for the list).

---

## Layout

```
packages/core/     pure domain logic - no I/O, no database, no clock it does not own
apps/api/          Fastify app, services, migrations, seed
apps/web/          React SPA served by the API in production
scripts/           openapi generation, acceptance harness
docs/              this directory
```

`packages/core` holds the parts where a bug is a *correctness* bug rather than a
crash: the result pipeline, normalization, aggregation, pairwise ranking, the
assignment engine, the rubric, statistics, canonical JSON and hashing, and the
state machines. It has no dependencies beyond Node's standard library and is
tested without touching a database.

The dependency direction is one-way: `core` knows nothing about `api` or `web`.
`api` and `web` both depend on `core`. Keep it that way - the value of the
reproducibility guarantee comes from the ranking being computable from stored
inputs with no ambient state.

`docs/ARCHITECTURE.md` covers the request lifecycle and the storage model.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API with `--watch` plus the Vite dev server. |
| `npm run dev:api` / `dev:web` | Either half on its own. |
| `npm run build` | Builds the SPA into `apps/web/dist`. |
| `npm start` | Serves the API and the built bundle. |
| `npm run typecheck` | `tsc` over core + api + tests + scripts, then over the web app. |
| `npm test` | Core and API unit/integration tests. |
| `npm run test:core` / `test:api` | Either half. |
| `npm run test:e2e` | Builds, then runs the browser suite. |
| `npm run acceptance` | The end-to-end acceptance harness. |
| `npm run verify` | typecheck → test → build → e2e → acceptance. |
| `npm run migrate` | Applies pending migrations, then reports FK violations. |
| `npm run seed` | Seeds the demo dataset. |
| `npm run openapi` / `check:openapi` | Regenerate the spec, or fail if it is stale. |

Run `npm run verify` before pushing anything that changes behaviour. It is the
same command CI should run.

**There is no linter and no formatter.** TypeScript strict mode plus
`noUncheckedIndexedAccess` does most of that work. Do not add one as part of
unrelated work - it is a separate decision with its own rollout.

---

## Testing

### Unit and integration - `npm test`

441 tests over 70 suites. Every API test boots the **real** Fastify instance
through `app.inject`, against a **real SQLite file on disk** - not a mock and not
`:memory:`. Migrations, `STRICT` tables, foreign keys, `CHECK` constraints and
triggers are therefore exercised for real, which is most of why the schema's
integrity claims can be made at all.

Each test owns a private temp directory and removes it on close. Call
`harness.close()` from an `after` hook. Two things bite on Windows specifically:

- a SQLite connection left open keeps its `-wal` and `-shm` files, and Windows
  will not delete a directory containing one;
- two `after` hooks run in registration order, so a teardown that closes a
  connection and a teardown that deletes a directory must be **one** hook, or the
  delete comes first.

### Browser - `npm run test:e2e`

45 tests over 8 suites. Boots a real server on an OS-assigned port, serves the
real built bundle, and drives Chrome through Playwright - the same artifact the
Docker image ships. The bundle must be built, which is why this script builds
first.

Suites:

| File | Covers |
| --- | --- |
| `e2e/journeys.test.ts` | Public, sign-in, judge, organizer and participant journeys end to end. |
| `e2e/console.test.ts` | The 12-section organizer console. |
| `e2e/judging.test.ts` | The judge scoring surface: context, autosave, navigation, read-only lock state. |
| `e2e/surfaces.test.ts` | Project, certificate and invitation pages. |
| `e2e/responsive.test.ts` | Four viewports, overflow, accessible names, tap targets, heading structure. |

Two things to know when writing one:

- **In-page code is passed as a string**, not a function, because the Node
  typecheck deliberately omits the DOM library so a stray `document` in server
  code fails to compile. The alternative - reaching the DOM through
  `element.ownerDocument` - makes measurement code unreadable.
- **Assertions belong on the durable fact, not the transient one.** For a
  webhook, assert the queued delivery row rather than the HTTP response:
  delivery is asynchronous and best-effort by design, so a receiver being down
  must not be mistaken for the feature being broken. For autosave, assert the
  reloaded input value rather than a "Saved" string that also appears elsewhere
  on the page.

### Acceptance - `npm run acceptance`

35 checks covering the release checklist: the judging pipeline reproduces, the
role boundaries hold, the audit chain is intact, published results verify, the
browser pages render. It is not a substitute for the suites above; it is the
short list you can read to know what a release is claiming.

---

## Conventions worth following

**Comments explain why, not what.** The existing code is heavily commented and
the bar is a sentence explaining a decision or a bug that was already paid for.
A comment restating the line below it is noise. In particular, when a
non-obvious thing is done - a dispatch after a commit rather than inside a
transaction, a check that cannot fail, a cast that silences the compiler - say
what it replaces and what the consequence of the obvious version would have
been.

**The type system is part of the review.** `as never`, `as unknown as`, and a
`@ts-ignore` each remove a class of bug that the compiler was catching for free.
They are acceptable only with a comment saying what the cast is for. Two
`as never` holes have been found and closed this way.

**Two tsconfigs, on purpose.** `tsconfig.check.json` covers core, api, tests and
scripts with `types: ["node"]` and no DOM. `apps/web/tsconfig.json` covers the
browser. Putting them in one project would put browser globals in scope for
server code, where a stray `document` would typecheck happily and then fail at
runtime.

**Every route that changes something dispatches after the transaction commits.**
`db.transaction` holds the write lock, and the webhook attempt is deliberately
unawaited and writes its own outcome back to the database - dispatching inside
the transaction races the commit.

**A new route needs a registry entry.** `registry.register({ … })` next to the
handler, with a tag, an `auth` level and the permission it actually checks. The
OpenAPI document is generated from those entries, and `npm run check:openapi`
fails if the committed document is stale. `GET /api/openapi.json` and
`GET /api/docs` register themselves after the document is built and are
therefore never self-listed.

**A new migration is a new migration.** Migrations are checksummed and immutable;
editing an applied one is refused at boot. Add version 15 rather than touching 14,
and remember it will run against databases that already have 14.

---

## Testing a change that touches the browser

```bash
npm run build                 # e2e runs against apps/web/dist
npm run test:e2e
```

For layout work, `npm run test:e2e -- --test-name-pattern=viewport` runs just the
responsive suite. It will catch the two things that are invisible at 1440px:
horizontal overflow, and a heading or a tap target that only breaks at 390px.

---

## Troubleshooting

**A test fails only in the full run.** Almost always a shared file. Each harness
gets its own temp directory and its own port, so this means something is not
using one of them.

**A browser test times out waiting for a selector.** Check whether the text you
are matching is inside a `:has-text()` - that is a case-insensitive substring
match, so "Saved" also matches "Score every required criterion first", and the
wait resolves before the thing you care about has happened. Prefer a
machine-readable attribute (`data-save-state="saved"`) over visible text, which
is also what a stylesheet would key off.

**`npm run migrate` reports foreign key violations.** Expected after an upgrade
from a schema that lacked the constraint. SQLite does not re-validate existing
rows when a foreign key is added. See the integrity gaps in
`docs/DATA-MODEL.md`.

**Typecheck passes but the browser fails.** The Node project does not include the
DOM lib, so DOM code passed as a function would not have compiled - which is why
it is passed as a string. If a string throws, the error is a real runtime error
in the page; read it in the test output.
