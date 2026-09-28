# Threat model

What this system is defending, from whom, and what is left over. It is written
for the person who has to decide whether to trust Verdict with a real event -
usually not a security specialist - and for whoever gets paged.

The short version: the assets worth attacking are the **judging pipeline**, the
**accounts**, and the **published result**. Most of the engineering effort is
spent making the result hard to forge and the panel hard to impersonate. The
classic web-application attack surface is defended conventionally, and the
conventional parts are the ones that were most often missing before.

---

## Assets, in order of what hurts most if lost

| Asset | Loss |
| --- | --- |
| The integrity hash chain of published results | The result stops being arguable. The whole product claim is gone. |
| Judge reviews and identities | Judging is not blind, and a judge can be pressured or impersonated. |
| Declared conflicts of interest | A judge scores a project they are entangled in, and it is undetectable. |
| Organizer and admin accounts | One account is full control of an event, or of the platform. |
| The audit ledger | Nothing above can be defended after the fact. |
| Uploaded files and submitted content | Mostly a question of not attacking other users. |

---

## Trust boundaries

1. **The browser.** Untrusted. Every field it sends is validated and every
   permission re-checked server-side; nothing in the client decides access.
2. **A signed-in user.** Untrusted within their own scope. A judge is not a
   lesser organizer - they have their own scope and cannot read another judge's
   review, write an organizer action, or see the un-normalized panel.
3. **An organizer.** Trusted with one event, explicitly not with the platform.
   This is the boundary that matters most: an organizer must not be able to
   create a global role, reach another event, or become an admin.
4. **An admin.** Trusted platform-wide, and audited on every action.
5. **The database file.** Trusted, with one exception: `audit_events` is designed
   to be read-only even to code that has the file.
6. **A webhook receiver.** Fully untrusted, and treated as an SSRF vector
   because it is one - see below.
7. **The operator.** Trusted, and the only party who can read `SESSION_SECRET`,
   the database file, or the uploads directory.

---

## Authentication

**Passwords** are hashed with **scrypt** (RFC 7914) from the Node standard
library: `N=32768, r=8, p=1`, 64-byte key, 16-byte salt, roughly 32 MiB and
60-100 ms per hash. Stored as `scrypt$N$r$p$salt$key`, so the cost parameters can
be raised later without invalidating existing hashes - and they are: a successful
login against a hash with weaker parameters rewrites it and logs that it did.

Argon2id would be the better algorithm today. scrypt is used because bcrypt and
argon2id are native addons, and a native addon means a compiler or a prebuilt
binary at install time, which breaks the offline-install promise and makes the
Docker build platform-dependent. This is a real trade-off and it is recorded here
rather than hidden.

**Enumeration** is closed on every path that could leak one. A wrong password
and an unknown email return an identical `INVALID_CREDENTIALS` body, the login
endpoint runs a real scrypt verification against a dummy hash when the account
does not exist so the timings match, and a corrupt or tampered hash row burns the
same work rather than failing fast.

**Lockout** is 8 consecutive failures, 15 minutes, with `423 ACCOUNT_LOCKED` and
`retry-after: 900`. Enough to make online guessing expensive, short enough that
someone who fat-fingers their password twice is not locked out of a live event.
Resetting the counter happens on success and on a password change.

**Reset tokens** are random and stored as a SHA-256 digest, so the database does
not hold anything that can be replayed. `POST /api/auth/password-reset` reports
success whether or not the address has an account.

**Sessions** are 256-bit random cookies. Only the SHA-256 digest is stored, so a
database read does not yield usable sessions. Two expiries: 14 days idle
(refreshed at most every 5 minutes, so an active judge's session does not die
mid-event) and 90 days absolute. A password change revokes every other session.
A suspended or deactivated account is refused at the permission layer regardless
of its session.

**`SESSION_SECRET`** is the one value with no default. In production a missing
or too-short value is a **fatal boot error** rather than a warning, because the
alternative is a per-boot random secret that signs everyone out on every deploy.
It also signs cookie values and salts vote IP hashes. **Rotating it signs
everyone out** - set it once and keep it.

### Residual

- No MFA. A stolen password plus a working session is a compromised account.
  An operator who wants it needs a reverse proxy or a second factor in front.
- No password complexity or breach-list check. Length is the only real defence,
  and the sign-in rate limit is what makes guessing expensive.
- Sessions are not bound to IP or user-agent. That is deliberate - it breaks
  judges switching networks mid-event - and it means a stolen cookie is a
  complete session until it expires or is revoked.

---

## Authorization

One matrix, `apps/api/src/lib/rbac.ts`, is the only place a permission is
decided. Handlers call `requirePermission(services, ctx, resource, action,
ownership, audit)`; nothing grants access by other means. `GET /api/rbac/matrix`
publishes the whole thing, so the authorization model is inspectable rather than
inferred from route handlers.

Four roles - `PARTICIPANT`, `JUDGE`, `ORGANIZER`, `ADMIN` - and five scopes:

| Scope | Grants |
| --- | --- |
| `PUBLIC` | publicly visible content only |
| `OWN` | the record belongs to you |
| `ASSIGNED` | you are the assigned judge, or the owner, or a team member |
| `EVENT` | you organize this specific event |
| `ANY` | global `ADMIN` only |

Three decisions in that matrix are worth naming, because they are where the
product's integrity actually comes from:

- **Event creation is `ANY`, not `EVENT`.** An organizer creates their own event
  and becomes its organizer, but the act of creating a *platform-wide* object
  belongs to an admin. This is what stops an organizer minting a global role.
- **An event is never deleted, only archived.** `delete: { event: null }` in the
  organizer row. History is the product; a destroyed event cannot be audited.
- **A judge reads `score: OWN` and writes `score: ASSIGNED`.** A judge cannot
  read another judge's review by any path, and there is a test asserting it.

**Renaming is not granted.** There is no role that can edit a rubric version
once scoring exists, no role that can modify a published snapshot, and no role
that can edit a locked score. Those are refused at the database level as well as
in the matrix, so a service bug cannot get around them either.

Denials are written to the audit ledger with the full decision trail - which
role was considered, which scope it required - so a refusal is investigable
rather than a bare 403.

### Residual

- **`GET /api/events/{eventId}/submissions` has no `requirePermission` call.** It
  is guarded by a bespoke `canManageEvent` check in the route. The behaviour is
  correct; the enforcement is not in the matrix, so it is not covered by the
  matrix-level tests. Nine other operations are similar, and the full list is in
  `docs/API.md`.
- **The `auth` field in the route registry is a documentation label, not a
  guard.** It installs no hook and no pre-handler. Only `x-verdict-permission`
  and the matrix reflect what is enforced, and the audit found 16 operations
  where the two disagree.
- **Most handlers resolve the parent record before checking permission**, so an
  anonymous caller with a well-formed but nonexistent id gets `404`, not `401`.
  82 of 111 protected operations behave this way. Whether that ordering is
  intended is not documented anywhere; it does mean a client cannot rely on 401
  to mean "not signed in".

---

## Injection and output

**SQL.** All access goes through prepared statements with bound parameters. No
string interpolation into SQL anywhere in the service layer. Every table is
`STRICT` and every foreign key is enforced.

**XSS.** The single highest-value header for a page that renders
user-submitted text, and it used to be absent: the Fastify CSP was disabled with
a comment claiming the static handler set a real policy, and the static handler
set none. The policy is now applied to every response:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; connect-src 'self'; object-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'self'
```

`script-src 'self'` with no CDN and no `unsafe-inline` is the part that matters;
the bundle is a plain external module. `style-src` keeps `unsafe-inline` because
React inline `style` props genuinely require it - that is a deliberate,
documented gap, and it is a gap for style only, not script.

**File uploads.** The declared type, the file extension and the magic bytes must
all agree, so renaming `payload.html` to `payload.png` is refused. SVG is always
rejected: it is a script container. Files are served with `nosniff` and an
explicit `inline`/`attachment` disposition, and are checksummed on read.

**CSV and JSON exports** are generated, not concatenated from user input into a
spreadsheet formula position; exports are `no-store`.

### Residual

- `style-src 'unsafe-inline'` permits CSS-based exfiltration in a browser that
  allows it. Removing it means moving every inline style to a stylesheet, which
  is a real refactor rather than a header change.
- `frame-ancestors 'self'` still allows any page on the same origin to frame the
  app. `SAMEORIGIN` on `x-frame-options` matches it.
- The error handler replaces any message at status 500 or above with a fixed
  string, so an internal failure cannot leak a stack trace - but it also means
  the readiness probe's diagnostic text is masked, which is unhelpful during an
  incident.

---

## CSRF

A global `preHandler` on every route, including routes added later, so it
cannot be forgotten by omission. It short-circuits for `GET`, `HEAD` and
`OPTIONS` and guards `POST`, `PUT`, `PATCH` and `DELETE` in this order:

1. No session and a non-browser-simple content type: **pass**. A server-to-server
   client using `application/json` without cookies never needs the token, which
   is what makes the API usable from a script.
2. `Origin` present: its host must equal the `PUBLIC_URL` host or the request
   `Host`. Mismatch or unparseable is `403 ORIGIN_REJECTED`, audited.
3. No `Origin` but a `Referer`: the same check on the referer's host.
4. Session present: `x-verdict-csrf` must match the session's stored token,
   compared in constant time. Mismatch is `403 CSRF_FAILED`, audited.

The session cookie is `SameSite=Lax`, which is the first line of defence; the
token is the second.

**`Secure`** is on whenever `NODE_ENV=production`, and should be turned on the
moment the instance is served over https. A session cookie in clear text is
readable by anything on the path. **`HttpOnly`** is on for the session cookie and
deliberately off for the CSRF cookie, which the browser has to read.

### Residual

- The `Referer` branch is not audited, unlike the `Origin` branch.
- `SameSite=Lax` allows a top-level GET navigation to carry the cookie, so any
  state-changing GET would be exploitable. There is one GET that persists review
  flags (`/diagnostics`) and the code notes this is a trap for link previews. It
  is idempotent and creates no scoring data, so the exposure is limited to
  writing anomaly flags a person would write anyway - but it is a GET with a
  write, and that should be a POST.

---

## Server-side request forgery

A webhook URL is an organizer-supplied server-side fetch target: a textbook SSRF
vector that can reach the database host, a cloud metadata service, or an internal
admin panel. Mitigations, in order:

1. Only `http`/`https`, validated at creation time.
2. Private, loopback, link-local and CGNAT addresses refused by default.
   `ALLOW_PRIVATE_WEBHOOK_TARGETS` exists for local development and turning it on
   in production hands anyone who can create a webhook a way into your network.
3. The hostname is **re-resolved at delivery time** and every resulting address
   checked, so a DNS record that changes to `127.0.0.1` after creation is caught.
4. Redirects are not followed (`redirect: 'manual'`).
5. A timeout and a response size cap bound every attempt.

### Residual

- There is a **DNS-rebinding window** between the check and the connection. It is
  small and hard to close without a pinning resolver.
- Only *organizers* can register webhooks. A platform with many organizers of
  varying trust is a different risk model from a single internal deployment.
- `GET /api/uploads/{uploadId}` serves user-supplied bytes from the application
  origin, so a user who uploads an HTML file can put a page on the app's origin.
  `nosniff` and an explicit disposition blunt it; serving uploads from a separate
  origin would remove it.

---

## Rate limiting and abuse

Hand-rolled, in-process, fixed-window, keyed by account when signed in and by IP
otherwise. It is keyed on the account specifically so one person behind a shared
NAT cannot exhaust everyone else's budget.

| Budget | Default | Window |
| --- | --- | --- |
| global | 600 | 60 s |
| auth | 10 | 300 s |
| vote | 60 | 1 h |
| `password-reset` | 5 | 1 h (hard-coded) |

Exceeding a budget is `429` with `x-ratelimit-limit`, `x-ratelimit-remaining` and
`retry-after`. `GET /api/health` is exempt so a probe does not consume anyone's
budget.

`TRUST_PROXY` defaults to **false**, and that default matters: with it on and no
proxy in front, a client can spoof `X-Forwarded-For` and walk straight through a
per-IP limit. Only turn it on behind a proxy you control.

### Residual

- **The limiter is in-process.** Two instances behind a load balancer give each
  client two budgets. A multi-node deployment needs a shared store.
- Nothing limits CSV import size beyond the body limit, so a large import is a
  long request rather than a rejected one.
- The account lockout is per-account and therefore a **denial-of-service lever**:
  someone who knows an organizer's email can lock that organizer out for 15
  minutes at a time. The global auth budget bounds how fast.

---

## Data at rest

- Passwords: scrypt digests only.
- Session cookies, reset tokens, invitation codes: SHA-256 digests.
- Vote IP addresses: salted with `SESSION_SECRET` and stored as `ip_hash`. The
  salt is what makes the digest useless once the secret is rotated.
- Uploaded files: on disk under `STORAGE_DIR`, never in the database, served
  through the application.
- Certificates and participation records carry a content-derived reference and
  an integrity hash, so a rendered certificate can be verified without trusting
  the database that issued it.

There is **no encryption at rest**. Anyone with the database file or the uploads
directory has all of it. This is a deliberate consequence of the self-hosted,
single-file, inspectable design: the thing being defended is a published result
that must be independently reproducible, and end-to-end encryption would make
that harder to explain, not easier.

---

## Audit

Append-only, enforced by unconditional database triggers on `UPDATE` and
`DELETE`, with no foreign keys so the log survives deletion of what it
describes. Entries carry actor, roles, event, resource, previous and new state,
outcome, request id, IP and user agent. Permission denials are recorded, not just
successes. The chain digest exposed by `GET /api/events/{eventId}/audit` is what
lets an auditor see that entries have not been removed.

**It is not tamper-evident against an operator.** Anyone who can write to the
database file can delete a row by dropping the trigger first, and the file is not
cryptographically chained - the digest is computed over the sequence at read
time. A genuinely tamper-evident ledger needs an external anchor: periodically
publishing the digest somewhere the operator does not control.

---

## What an operator should do

1. Serve over https and set `SESSION_SECURE_COOKIES=true`.
2. Generate `SESSION_SECRET` once, store it, never rotate it mid-event.
3. Keep `AUTO_SEED=false` for a real event - the demo accounts share a published
   password.
4. Keep `ALLOW_PRIVATE_WEBHOOK_TARGETS=false` unless you are on localhost.
5. Set `TRUST_PROXY=true` **only** behind a proxy you control.
6. Back up with `VACUUM INTO` and test the restore (see `docs/OPERATIONS.md`).
7. Run `npm run migrate` as its own step, and read its output. A non-zero exit
   means foreign key violations to look at.
8. Put a reverse proxy in front for TLS, request logging and a second factor.
