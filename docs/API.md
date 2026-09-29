# HTTP API

140 operations across 120 paths, in 23 tags. Everything is under `/api`.

The machine-readable version is served by the running instance at
`GET /api/openapi.json`, with a browsable rendering at `GET /api/docs`. Both are
live routes; the checked-in `openapi.json` is a build artefact of the same
registry.

---

## Conventions

### Base URL and identifiers

`servers[0].url` is `PUBLIC_URL` **as it was when the spec was generated**,
default `http://localhost:8080`. Set it before generating if the spec is going
to be published for a different deployment.

Every identifier is an opaque string of 3-64 characters. There is no pattern to
match on; ids are prefixed (`evt_`, `sub_`, `asg_`, `usr_`, …) but nothing
depends on the prefix.

### Errors

One envelope, for every error this API raises itself:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request body did not match the expected shape.",
    "requestId": "req_3f1c8a2e-...",
    "details": [{ "field": "password", "issue": "Too small" }]
  }
}
```

`details` is present only when non-empty. `message` is human prose and is
**replaced with a fixed string at any status 500 or above**, so an internal
failure cannot leak a stack trace - and the readiness probe's diagnostic text is
masked for the same reason.

There is one exception to the envelope, and a client has to handle it: an unknown
path or wrong method returns Fastify's `{"message","error","statusCode"}` shape
rather than this one, for every method except `GET`/`HEAD`. `POST /api/nope`
gives you `"error": "Not Found"` rather than `"error": {"code": "NOT_FOUND"}`.
Whether that happens depends on whether a web build is present at boot, because
the SPA catch-all is what produces the shaped 404 for GET.

### Error codes

| Code | Status | Meaning |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | Structurally unusable: malformed JSON, an unknown enum value, a `Content-Length` that disagrees with the body, a CSV with no header row. |
| `UNAUTHENTICATED` | 401 | No valid, unexpired session. Also returned by the permission check for an anonymous caller, so 401 sometimes means "not allowed". |
| `INVALID_CREDENTIALS` | 401 | Email or password wrong. Identical body for an unknown address, so accounts cannot be enumerated. |
| `ACCOUNT_LOCKED` | 423 | 8 consecutive failures; 15 minutes. Carries `retry-after: 900`. |
| `ACCOUNT_SUSPENDED` | 403 | Credentials matched, account is suspended or deactivated. |
| `FORBIDDEN` | 403 | The matrix does not grant this. `details[0]` carries the decision trail. |
| `NOT_FOUND` | 404 | No such resource, or no such endpoint. |
| `PAYLOAD_TOO_LARGE` | 413 | Body or upload over the limit. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Declared type, extension and magic bytes do not agree; SVG is always refused. |
| `CONFLICT` | 409 | Duplicated slug or email, or reassigning a submitted review. |
| `ILLEGAL_TRANSITION` | 409 | The state machine does not allow that move. |
| `DEADLINE_PASSED` | 409 | A window has closed and the record is frozen. |
| `WINDOW_CLOSED` | 409 | The relevant voting/registration/judging window is shut. |
| `IMMUTABLE` | 409 | Publish a correction or a new version instead. |
| `CONFLICT_OF_INTEREST` | 409 | A declared conflict forbids this. |
| `CSRF_FAILED` | 403 | `x-verdict-csrf` missing or wrong. |
| `ORIGIN_REJECTED` | 403 | `Origin`/`Referer` host is neither `PUBLIC_URL`'s nor the request `Host`. |
| `PRECONDITION_FAILED` | 412 | A stated precondition failed: stale `inputHash`, unconfirmed warnings, missing `confirm: true`, or a snapshot that does not reproduce (with a field-level diff). |
| `VALIDATION_FAILED` | 422 | One or more fields failed. `details` names them. |
| `RATE_LIMITED` | 429 | Carries `retry-after`. |
| `SERVICE_UNAVAILABLE` | 503 | A dependency is down. Only `/api/ready` raises it. |
| `INTERNAL_ERROR` | 500 | Anything unmapped. Message is always the generic text. |
| `METHOD_NOT_ALLOWED` | 405 | **Declared but never thrown.** A wrong method on an existing path is a 404. |
| `NOT_IMPLEMENTED` | 501 | **Declared but never thrown.** |

### Pagination

`?page=` (1-based, default 1) and `?perPage=` (default 25, max 200) on every
paginated endpoint. Out of range is **rejected with 422, not clamped**, so
`?perPage=500` fails rather than quietly becoming 200.

```json
{ "data": [ … ], "pagination": { "page": 1, "perPage": 25, "total": 0, "totalPages": 0, "hasMore": false } }
```

Twelve endpoints use that envelope. Fourteen more return a bare `{"data": […]}`
with no pagination - do not send paging parameters to them and do not expect a
`pagination` key: `tracks`, `prizes`, `rubrics`, `gallery/technologies`,
`conflicts`, `webhooks`, `results/runs`, `results/snapshots`,
`normalization/runs`, `participation-records`, `comments/moderation`, `scores`,
`webhooks/{id}/deliveries`, and `auth/sessions`.

Shapes that are not `data`-wrapped: `registration/form` returns
`{ eventId, fields }`; `registration/me` returns `{ registration: null }` when you
have not applied; `teams/mine` returns `{ team: null }`; `results` returns
`{ published: false, entries: [], note }` when nothing is published.

### Sessions and CSRF

`POST /api/auth/login` sets two cookies: `verdict_session` (HttpOnly,
`SameSite=Lax`) and `verdict_csrf` (**not** HttpOnly - the browser has to read
it). Both responses also return `csrfToken` in the body for a non-cookie client.

Every unsafe method needs `x-verdict-csrf` matching the session's token, **unless**
there is no session and the content type is not a browser-simple type - so a
server-to-server caller using `application/json` and no cookies never needs it.
Cross-origin browser requests are additionally rejected on `Origin` or `Referer`.

### Request ids

The server generates `req_<uuid>` per request, records it in the audit ledger and
in logs, and **echoes it as `x-request-id` on every response**, including error
responses.

A caller may supply its own. An inbound `x-request-id` is used when it is 8-128
characters of `[A-Za-z0-9._:-]`; anything else is ignored and a fresh id is
generated. A malformed id is ignored rather than refused on purpose - a debugging
aid must not be able to cause a denial of service - and a response always carries
an id either way.

The value in the header is the same one written to the audit rows, so a header
from a response and a `requestId` in `GET /api/events/{eventId}/audit` can be
matched directly.

One implementation note, because the obvious approach is wrong: this is done
with Fastify's `genReqId` and **not** with `requestIdHeader`. `requestIdHeader`
copies the header value into `request.id` verbatim without validating it, which
would let a caller put arbitrary content - another user's correlation id, a
newline, megabytes of junk - into the audit ledger, the logs and the response
header. Going through `genReqId` alone means the id is checked once, in one
place.

### Idempotency

There is no `Idempotency-Key`. Four operations are naturally idempotent and
described as such: applying to an event, `certificates/issue-all`,
`participation-records`, and casting a vote (a unique constraint makes a second
vote a no-op). `assignments/commit` is the opposite - it requires a fresh
`inputHash` from `preview` and refuses a stale one with 412.

### Authorization levels

`x-verdict-auth` in the spec is a **documentation label, not a guard**. It
installs nothing. The enforced model is the matrix at `GET /api/rbac/matrix`;
`x-verdict-permission` describes the `requirePermission` call where there is one,
but 16 operations declare a permission the handler does not check, or check one
the registry omits. Where the two disagree, the handler wins.

| Label | Count | Means |
| --- | --- | --- |
| `none` | 31 | No session advertised. The handler may still require one conditionally (a private results board, a non-public upload). |
| `session` | 45 | A valid session cookie. |
| `organizer` | 63 | `ORGANIZER` on the `{eventId}` in the path, or `ADMIN`. |
| `admin` | 3 | Global `ADMIN`. |

### Rate limits

Keyed by account when signed in, by IP otherwise. In-process and fixed-window.

| Budget | Default | Window | Applies to |
| --- | --- | --- | --- |
| global | 600 | 60 s | everything not exempt |
| auth | 10 | 300 s | any `/api/auth/*` |
| vote | 60 | 1 h | `POST` to `/votes`, `/vote`, `/pairwise` |
| password reset | 5 | 1 h | `POST /api/auth/password-reset` (hard-coded) |

Responses carry `x-ratelimit-limit` and `x-ratelimit-remaining`; a 429 adds
`retry-after` in seconds. `/api/health` is exempt and sends neither header.

### Security headers

On every response: CSP, `x-content-type-options: nosniff`,
`referrer-policy: strict-origin-when-cross-origin`, `x-frame-options: SAMEORIGIN`,
COOP and CORP `same-origin`, `x-download-options: noopen`,
`x-dns-prefetch-control: off`, `x-permitted-cross-domain-policies: none`,
`x-xss-protection: 0`. HSTS only when `NODE_ENV=production` **and**
`PUBLIC_URL` is `https`. See `docs/THREAT-MODEL.md`.

---

## Endpoints

Real success status in parentheses. `(201)` where an item was created, `(204)`
where there is no body.

### meta

| Operation | Auth | Notes |
| --- | --- | --- |
| `GET /api/health` | none | Liveness. Not in the published spec (registered `hidden`). |
| `GET /api/ready` | none | Readiness; 503 when migrations are pending or the database is down. Also `hidden`. |
| `GET /api/capabilities` | none | What this deployment supports: methods, strategies, upload rules, limits. |
| `GET /api/lifecycle` | none | Every state machine and its legal transitions, with reasons. |
| `GET /api/rbac/matrix` | none | The complete role matrix. `null` means never granted. |
| `GET /api/openapi.json` | none | The live spec. Not self-listed - it is registered after the document is built. |
| `GET /api/docs` | none | HTML rendering of the spec. |

### auth

| Operation | Auth | Notes |
| --- | --- | --- |
| `POST /api/auth/register` | none | 201. Creates an account with `PARTICIPANT` and signs in. |
| `POST /api/auth/login` | none | Sets both cookies, returns `{ user, csrfToken }`. Locks after 8 failures. |
| `POST /api/auth/logout` | session | 204, and 204 for an anonymous caller too. |
| `GET /api/auth/session` | none | 200 with `authenticated: false` rather than 401. |
| `POST /api/auth/password` | session | Revokes every other session. |
| `POST /api/auth/password-reset` | none | Always reports success; the token is in the body. |
| `POST /api/auth/password-reset/complete` | none | |
| `GET /api/auth/sessions` | session | Your live sessions. `{ data, note }`, unpaginated. |
| `DELETE /api/auth/sessions/{sessionId}` | session | **200 `{ revoked: true }`**, not 204. 404 if not yours. |

### profile

`GET /api/profile` (session), `PATCH /api/profile` (session) - display name,
bio, organization, links, skills, avatar colour.

### events

| Operation | Auth | Notes |
| --- | --- | --- |
| `GET /api/events` | none | Query: `state`, `search`, `page`, `perPage`. |
| `POST /api/events` | session | 201. Creator becomes organizer; a default form is created. |
| `GET /api/events/{eventId}` | none | With live window status. |
| `PATCH /api/events/{eventId}` | organizer | |
| `POST /api/events/{eventId}/transition` | organizer | Illegal move is 409. |
| `GET /api/events/{eventId}/transitions` | none | Current state, all tables, available moves, window dates. |
| `GET`/`POST /api/events/{eventId}/tracks` | none / organizer | |
| `GET`/`POST /api/events/{eventId}/prizes` | none / organizer | |

### registration

| Operation | Auth | Notes |
| --- | --- | --- |
| `POST /api/events/{eventId}/registration` | session | 201. Re-applying updates the existing application. |
| `GET /api/events/{eventId}/registration/form` | none | `{ eventId, fields }`. |
| `POST /api/events/{eventId}/registration/form/fields` | organizer | 201. |
| `DELETE /api/events/{eventId}/registration/form/fields/{fieldId}` | organizer | 204. |
| `GET /api/events/{eventId}/registration/me` | session | `{ registration: null }` if not applied. |
| `GET /api/events/{eventId}/registrations` | organizer | Applicant queue with `byState`. |
| `POST /api/events/{eventId}/registrations/{registrationId}/decision` | organizer | |
| `POST /api/events/{eventId}/registrations/bulk` | organizer | 1-500 ids, each validated independently. `ids`, not `registrationIds`. |
| `GET /api/events/{eventId}/registrations/export` | organizer | CSV including custom responses. |

### teams

| Operation | Auth | Notes |
| --- | --- | --- |
| `GET /api/events/{eventId}/teams` | none | Paginated. |
| `POST /api/events/{eventId}/teams` | session | 201. You become captain. |
| `GET /api/events/{eventId}/teams/mine` | session | `{ team: null }` if none. |
| `GET /api/teams/{teamId}` | none | With members. |
| `PATCH /api/teams/{teamId}` | session | **Captain only**, despite the generic summary. |
| `POST /api/teams/{teamId}/invitations` | session | 201. Captain only. Returns a `url` on `{PUBLIC_URL}/invite/{code}` - a web path, not an API path. |
| `DELETE /api/teams/{teamId}/members/{userId}` | session | 204. Doubles as "leave": pass your own id. |
| `POST /api/teams/{teamId}/captain/{userId}` | session | Transfer captaincy. |
| `POST /api/teams/{teamId}/override` | organizer | On a frozen team, with a reason of 8+ characters. |
| `GET /api/invitations/{code}` | none | The invited address is not disclosed to anonymous callers. |
| `POST /api/invitations/{code}/accept` | session | |
| `POST /api/invitations/{code}/reject` | session | |

### submissions

| Operation | Auth | Notes |
| --- | --- | --- |
| `GET /api/events/{eventId}/submissions` | organizer | Guarded by a bespoke `canManageEvent`, not the matrix. Non-managers get 403 telling them to use the gallery. |
| `POST /api/events/{eventId}/submissions` | session | 201, state `DRAFT`. |
| `GET /api/submissions/{submissionId}` | none | **The shape depends on the caller.** Owners and organizers get draft fields, team, members, screenshots and a `canEdit` object; everyone else gets the public view. |
| `PATCH /api/submissions/{submissionId}` | session | 409 `DEADLINE_PASSED` after the window. |
| `POST /api/submissions/{submissionId}/submit` | session | After the deadline only `{ override: true, reason }` works, and it is audited. |
| `POST /api/submissions/{submissionId}/withdraw` | session | Back to draft, inside the window only. |
| `POST /api/submissions/{submissionId}/transition` | organizer | |
| `GET /api/submissions/{submissionId}/versions[/{version}]` | session | Immutable history; each version carries a full `snapshot`. |
| `GET /api/events/{eventId}/gallery` | none | Filters `search`, `trackId`, `technology`, `teamId`, `sort`. Randomized order is seeded per event per day. |
| `GET /api/events/{eventId}/gallery/{slug}` | none | Project page. |
| `GET /api/events/{eventId}/gallery/technologies` | none | Facets with counts. |
| `GET /api/embed/{eventId}.json` | none | **The `.json` suffix is literal.** `?limit=` (default 24, max 200). CORS `*`, cache 60 s. |
| `POST`/`GET`/`DELETE /api/submissions/{id}/uploads`, `GET /api/uploads/{uploadId}` | session / none / session | `multipart/form-data` with a `file` part; 8 MiB; PNG/JPEG/WEBP/GIF only. |

### judges, conflicts, assignments

| Operation | Auth | Notes |
| --- | --- | --- |
| `GET /api/events/{eventId}/judges` | organizer | With workload and progress. |
| `POST /api/events/{eventId}/judges/invite` | organizer | 201. Partial failures reported per identifier. |
| `POST /api/judges/{judgeId}/accept` | session | 401 when anonymous. |
| `PATCH /api/judges/{judgeId}/capacity` | organizer | 0-500. |
| `POST /api/judges/{judgeId}/transition` | organizer | Labelled organizer, but a judge may decline their own invitation. |
| `GET /api/events/{eventId}/conflicts` | organizer | A judge can **not** read the register. |
| `POST /api/events/{eventId}/conflicts` | session | 201. Anyone may declare against themselves. |
| `DELETE /api/conflicts/{conflictId}` | session | 204. |
| `GET /api/events/{eventId}/assignments` | organizer | With coverage and current version. |
| `POST /api/events/{eventId}/assignments/preview` | organizer | Dry run, writes nothing. |
| `POST /api/events/{eventId}/assignments/commit` | organizer | 412 on a stale `inputHash` or unconfirmed warnings. |
| `POST /api/assignments/{assignmentId}/reassign` | organizer | Needs a written reason. |
| `POST /api/assignments/{assignmentId}/conflict-override` | organizer | Needs `confirm: true` and a 15-character reason. |

### rubrics

`GET`/`POST /api/events/{eventId}/rubrics`, `GET /api/rubrics/{rubricId}/versions`,
`POST /api/rubrics/{rubricId}/versions` (201; `activate` defaults true),
`GET /api/rubric-versions/{versionId}`, `PATCH /api/rubric-versions/{versionId}`.
Weights are fractions summing to 1.0. Editing a version that has scoring against
it is 409 `IMMUTABLE`.

### scoring and calibration

| Operation | Auth | Notes |
| --- | --- | --- |
| `GET /api/events/{eventId}/judging/queue` | session | 403 if not on the panel. |
| `GET /api/assignments/{assignmentId}/review` | session | Get-or-create: opens an empty DRAFT if none. 403 for a non-owner, not 401. |
| `POST /api/assignments/{assignmentId}/review` | session | Open or resume. |
| `PUT /api/assignments/{assignmentId}/review` | session | Autosave. Out-of-range values are **rejected 422, not clamped**. |
| `POST /api/assignments/{assignmentId}/review/submit` | session | 422 if a required criterion is missing. |
| `GET /api/events/{eventId}/scores` | organizer | Score table. |
| `GET`/`POST /api/events/{eventId}/pairwise[/queue]` | session | `?pairs=` on the queue (default 20, max 200). |
| `GET /api/events/{eventId}/comparisons` | organizer | `{ data, counts, note }`. |
| `POST /api/events/{eventId}/calibration` | organizer | 201. |
| `GET`/`POST /api/calibration/{sessionId}/[scores]` | session | Diagnostic only; never affects a ranking. |

### results

| Operation | Auth | Notes |
| --- | --- | --- |
| `POST /api/events/{eventId}/results/compute` | organizer | `persist` defaults true; `persist: false` returns without storing. |
| `GET /api/events/{eventId}/results/runs` | organizer | |
| `POST /api/events/{eventId}/results/{runId}/snapshot` | organizer | 201. Immutable, append-only. |
| `GET /api/events/{eventId}/results/snapshots` | organizer | |
| `POST /api/events/{eventId}/results/snapshots/{snapshotId}/publish` | organizer | **Reproduces first**; 412 with a field-level diff on mismatch. |
| `POST /api/events/{eventId}/results/snapshots/{snapshotId}/reproduce` | organizer | MATCH, or a per-project diff. |
| `GET /api/events/{eventId}/results` | none | 403 when `results_visibility` is `PRIVATE`. Judge counts and criterion breakdowns are **omitted entirely** when disabled, not blanked. |
| `GET /api/results/verify/{reference}` | none | `reference` must be `eventId::snapshotId`, else 400. |

### diagnostics, normalization, anomalies

`GET /api/events/{eventId}/diagnostics` (organizer) - panel health. **It is a
GET that persists review flags**; the code notes this is deliberate and that the
alternative is a link preview silently writing. `GET /api/events/{eventId}/anomalies`,
`POST /api/events/{eventId}/anomalies/{anomalyId}` (organizer; dismissing or
resolving needs a conclusion of 5+ characters). `GET
/api/events/{eventId}/normalization/comparison[?method=]` and `/runs`
(organizer).

### community

`GET`/`POST /api/submissions/{submissionId}/comments` - the GET is public and
paged with `page`/`perPage`; hidden comments are included only for organizers.
`POST /api/events/{eventId}/votes` (201, re-voting is a no-op), `DELETE
/api/events/{eventId}/votes/{submissionId}`, `GET .../votes/mine`,
`GET .../votes/report` (organizer), `POST /api/votes/{voteId}/moderate`
(organizer, with a reason), `POST /api/comments/{commentId}/report`,
`GET /api/events/{eventId}/comments/moderation`,
`POST /api/comments/{commentId}/moderate`, `DELETE /api/comments/{commentId}`
(soft delete).

### certificates

`GET /api/certificates/{reference}` (none) reports VALID / REVOKED / TAMPERED /
NOT_FOUND. `GET /api/certificates/{reference}.svg` renders it - note the route
is a literal suffix, so `REF1.png` falls through to the **verification** endpoint
with the dot still in the reference.
`GET`/`POST /api/events/{eventId}/certificates` (201 on create),
`POST .../certificates/issue-all` (idempotent),
`POST .../certificates/{certificateId}/revoke` (reason 5+ characters; the record
is retained), `GET`/`POST /api/events/{eventId}/participation-records`
(idempotent).

### webhooks

`GET`/`POST /api/events/{eventId}/webhooks` (201), `GET
/api/webhooks/{webhookId}/deliveries` (`?limit=`, default 50, max 500), `POST
/api/webhooks/deliveries/{deliveryId}/redeliver`, `DELETE
/api/webhooks/{webhookId}` (204).

Ten topics, listed with their labels at `GET /api/capabilities` and rendered in
the console from the same source: `registration.accepted`, `team.created`,
`submission.created`, `submission.locked`, `judge.assigned`, `score.submitted`,
`judging.completed`, `results.finalized`, `results.published`,
`certificate.generated`.

Each delivery carries `X-Verdict-Id`, `X-Verdict-Event`, `X-Verdict-Timestamp`
and `X-Verdict-Signature: v1=<hex hmac-sha256 of "id.timestamp.body">`. The
timestamp is inside the signed material, which is what makes a captured delivery
unusable outside its retry window. Payloads carry ids, counts and hashes - never
scores, names or standings. An unknown topic is rejected with 422 rather than
silently dropped.

### imports, exports, audit, admin

`POST /api/events/{eventId}/imports/{judges,participants,teams}` - `dryRun`
defaults **true**. `GET /api/events/{eventId}/exports/{kind}` (CSV) and
`{kind}.json`, where `kind` is one of `REGISTRATIONS, PARTICIPANTS, TEAMS,
SUBMISSIONS, JUDGES, ASSIGNMENTS, SCORES, RESULTS, VOTES, COMMENTS, ANOMALIES,
WEBHOOKS, AUDIT`; `GET .../exports/manifest` is a static route that correctly
shadows `{kind}`. `GET /api/events/{eventId}/audit` (organizer) with a chain
digest. `GET /api/admin/overview`, `POST /api/admin/users/{userId}/roles`,
`POST /api/admin/users/{userId}/state` (admin), and `GET /api/users/search`
(organizer, despite living under `/api/users`).

---

## The published document is checked against the running server

`npm run openapi` writes `openapi.json`; `npm run check:openapi` fails if the
committed document is stale, so adding or removing a route requires both. The
stale check is necessary but not sufficient, because a generator can be wrong in
the same way on every run. `apps/api/test/openapi-truth.test.ts` therefore
compares the document the server actually serves against behaviour measured from
a live, seeded instance, and `npm test` runs it.

It asserts, among other things:

- every operation declares exactly one success status, and it is the one the
  handler actually returns - `POST /api/events/{eventId}/teams` is driven for
  real and must come back 201, not the 204 the old default claimed;
- the only `POST` documented as 204 is logout, pinned as an explicit list so a
  new one has to be justified;
- query schemas appear as individual named parameters, not one object-valued
  `query`;
- a rate-limit-exempt route does not advertise 429, while the other 100+ that
  legitimately can still do;
- the upload endpoint documents its `multipart/form-data` body;
- every operation in the document is a route Fastify really serves, probed with a
  synthetic id, distinguishing a missing route from a handler's own domain 404;
- a supplied `x-request-id` is echoed, a malformed one is ignored rather than
  refused, and the id in the header is the same one written to the audit ledger;
- public participation verification publishes no numeric score.

### What is still approximated

These affect a client that trusts the document, and none affects server
behaviour:

1. **Synthetic `401`/`403` responses are advertised for every protected
   operation.** Most handlers resolve the resource before checking permission
   and so return `404` to a caller with no access. The document lists `401` and
   `403` as the truthful possibilities, which is the useful description for a
   client but not the exact one. Deriving the real per-handler precedence would
   mean every route declaring its own failure set.
2. **Response bodies are described by schema, not by example per operation.** The
   error and pagination shapes are shared and exact; the success payloads are
   covered by the shared `Error` and `Pagination` components plus the test suite
   rather than a per-operation schema.
3. **The document is generated from the same Zod schemas the server validates
   with.** That is a strong guarantee for bodies and queries - the schema in the
   document is the schema in use - but it means the *shape of a route* is a
   human declaration (`success`, `rateLimited`, `multipart`, `auth`) and can still
   be wrong. The truth test is what catches that.
