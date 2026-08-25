# rakesetu-backend

API for **RakeSetu** — Freight Operations & Rake Turnaround Intelligence Platform.

Express 5 · TypeScript · Drizzle ORM · PostgreSQL 16 (pgvector) · Redis · RabbitMQ · JWT auth with organization-scoped RBAC.

> Architecture and the full product design live in [`../docs/DESIGN.md`](../docs/DESIGN.md).
> The build order is in [`../docs/phases/`](../docs/phases/README.md), and the
> decisions frozen along the way in [`../docs/phases/DECISIONS.md`](../docs/phases/DECISIONS.md).

## What exists today

**Phase 1 — the platform & security spine.** Everything that is expensive or
impossible to retrofit is in place: a permission model, tenant scoping enforced
in the repository layer, an append-only audit log, idempotency, correlation ids,
Redis, `ai_jobs` with a typed publisher, cookie-based auth, a pagination
contract, and a test harness that runs against a real Postgres in a container.

**Phase 2 — user administration.** Seven endpoints over `/api/v1/users`, all of
them through `ScopedRepository` and all of them audited, plus the resolved
permission union on `/users/me` so the SPA can gate its own UI from the same map
the server enforces. `GET /audit` gained a `correlationId` filter, which is what
turns "something changed" into "here is the whole of what that one click did".

**Phase 3 — master data, the network and documents.** Fourteen tables of
reference data with the tenancy line drawn deliberately across them: the rail
network, wagon types, commodities and the charge rule book are **global** and go
through `UnscopedRepository`; terminals, wagons, rakes, customers and embargoes
belong to a zone and go through `ScopedRepository`. With them come the two
distance functions (`tariffKm` looks up and refuses to guess; `operationalKm` is
Dijkstra over the sections), the `asOf` charge-rule resolver that has no
"current" shorthand, the versioned rake composition and the `getRakeConstraints`
read that is genuinely as-of, an embargo scope contract shared with the matcher
Phase 7 will write, and private object storage on S3/MinIO with fifteen-minute
presigned URLs that are never persisted. `npm run db:seed` loads the network the
rest of the product simulates against.

The freight domain proper (indents, the event spine, the solver, charges, RAG)
is designed but not yet built — that starts at Phase 4.

### The two load-bearing pieces

**Tenant scoping is structural, not a check.** `ScopedRepository` has no method
that can produce SQL without `org_id = :orgId` in the predicate, and no way to be
constructed without an orgId:

```ts
const repo = req.tenant.repo(indents); // bound to the caller's org
await repo.findById(someIdFromAnotherTenant); // null — not "forbidden", absent
await repo.insert({ ...body, orgId: theirs }); // writes YOUR orgId regardless
```

Globally shared reference data — stations, sections, wagon types — uses the
deliberately conspicuous `UnscopedRepository` instead. Seeing that name on a
table with an `org_id` column is the review finding.

**The audit log cannot be rewritten.** Migration `0001` installs
`DO INSTEAD NOTHING` rules, so an UPDATE or DELETE against `audit_log` affects
zero rows and raises no error — for every role, superuser included, and for code
that never heard of `AuditService`. Clearing it (a reseed, a test) is
`TRUNCATE audit_log`, which the rule system does not rewrite.

That has one consequence worth knowing before it surprises you: both foreign keys
out of `audit_log` are `ON DELETE RESTRICT`. A cascade action would be
implemented as an UPDATE, the rule would rewrite it away, and the _originating_
delete would fail with `XX000`. So **truncate the audit log before deleting users
or organizations**, which is what `npm run db:seed -- --reset` does. The reasoning
is in [`DECISIONS.md` D5](../docs/phases/DECISIONS.md).

## Quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
#    …then edit DB credentials and JWT secrets if yours differ

# 3. Infrastructure
docker compose up -d postgres redis rabbitmq mailpit minio
#    Postgres :55433 (pgvector/pgvector:pg16) · Redis :6379 · broker :5674
#    MinIO :9100, console :9101 (minioadmin/minioadmin) — the `minio-init`
#    one-shot creates both buckets; without it the first upload is a NoSuchBucket
#    that reads like a credentials problem and is not.
#    .env.example already points at these. A local Postgres on :5432 works for
#    scratch work but has no pgvector, so it is not what the project targets.
#    No broker at hand? set USE_RABBITMQ_SERVICE=false and jobs run inline.

# 4. Migrate + seed (seed is mandatory — there is no public signup)
npm run db:migrate
npm run db:seed
#    …loads the rail network too: ~59 stations, 116 directed sections, 12
#    terminals, 40 rakes, 25 customers and 30 charge rules — plus a short event
#    ladder per rake, so the map has something to draw before the simulator has
#    ever run and `POST /reproject` is honest on a fresh database.
#    `-- --master-only` reloads reference data and leaves accounts alone.

# 5. Partitions for `rake_events` (this month + the next three)
npm run db:partitions
#    Idempotent. Belongs in a monthly cron; nothing breaks the day it is
#    forgotten, because a DEFAULT partition catches out-of-range rows — but the
#    script reports anything that lands there, and a default partition quietly
#    collecting a month of events is a table scan hiding inside every query.

# 6. Replay a month of freight movement — THE STANDARD DEMO COMMAND
npm run simulate -- --days 30 --speed 100 --seed 42
#    ~21,000 events in a few minutes. `--seed 42` twice produces an identical
#    stream on every machine, which is what makes "the solver skipped R-4412" a
#    sentence that means the same thing in two places.
#
#    --dry-run  generate and count, write nothing
#    --live     after backfilling, keep emitting against a compressed clock so
#               the map at /app/controller/network visibly moves
#
#    It supersedes the placeholder event ladder `db:seed` writes (source_ref =
#    'seed'), and resumes from — never rewrites — anything a person or an
#    earlier run recorded.

# 7. Run
npm run dev
```

The server listens on `PORT` (default `4000`).

| Endpoint       | Answers                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `GET /healthz` | Liveness. 200 whenever the process is up, no dependency checks.                                 |
| `GET /readyz`  | Readiness. 503 with a per-dependency breakdown if Postgres, Redis or the broker is unreachable. |
| `GET /health`  | The original combined check, kept for whatever already polls it.                                |

The split matters: an orchestrator restarts a container that fails _liveness_, so
a database check in `/healthz` would turn a brief Postgres blip into a
simultaneous restart of every replica.

## Tests

```bash
npm test              # everything
npm run test:isolation  # the cross-tenant suite specifically
npm run test:watch
```

`vitest` + `supertest` + **testcontainers**. The suite starts its own Postgres
(`pgvector/pgvector:pg16`, the same image compose runs) and Redis, applies the
migration _files_ — not a pushed schema, because the append-only rules exist in
no schema file — seeds both tenants, and tears the containers down afterwards.
Nothing depends on a local database, and nothing it does touches one.

| Suite                    | Proves                                                                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isolation/cross-tenant` | One tenant cannot read, list, update, delete, count or paginate another's rows — through the repository and over HTTP. **Grows by one block per tenant-scoped table in every later phase.**                                                                             |
| `suites/permissions`     | Every role against every guarded route, table-driven from `ROLE_PERMISSIONS` itself                                                                                                                                                                                     |
| `suites/audit`           | Rows are written with correct `before`/`after`; UPDATE and DELETE are silently discarded; a failed audit write does not fail the request                                                                                                                                |
| `suites/idempotency`     | Same key twice → one effect; concurrent same key → one 2xx and one 409; a failure releases the key                                                                                                                                                                      |
| `suites/auth`            | Refresh cookie is httpOnly/Strict and absent from the body; refresh works from the cookie alone; logout revokes the row; the lockout and the login limiter                                                                                                              |
| `suites/health`          | `/readyz` goes 503 naming Redis while `/healthz` stays 200                                                                                                                                                                                                              |
| `suites/ai-job`          | `enqueue` writes a row, publishes it, and the row reaches `succeeded`                                                                                                                                                                                                   |
| `suites/platform`        | Pagination envelope and clamping, correlation ids, security headers, the Redis lock                                                                                                                                                                                     |
| `suites/user-admin`      | `/users/me` returns exactly `ROLE_PERMISSIONS[role]` for each of the six roles and their union for a multi-role account; creation cannot escape its tenant even when the body names another; revoking preserves the grant row; no response ever carries a password hash |

The isolation suite is self-checking: delete the `eq(table.orgId, …)` from
`ScopedRepository.where` and eight of its cases fail. That is worth doing once.

## Seeded accounts

All use the password `Rakesetu@123`. Add `-- --reset` to clear the seeded tables
first.

Central Railway (`CR`) — a railway zone holding all six roles, one user each,
plus one account holding two of them:

| Email                                 | Name            | Role                                         |
| ------------------------------------- | --------------- | -------------------------------------------- |
| `admin@cr.rakesetu.dev`               | Asha Deshmukh   | admin                                        |
| `zonal_manager@cr.rakesetu.dev`       | Vikram Rao      | zonal_manager                                |
| `freight_controller@cr.rakesetu.dev`  | Nilesh Kulkarni | freight_controller                           |
| `terminal_supervisor@cr.rakesetu.dev` | Farida Shaikh   | terminal_supervisor                          |
| `commercial_officer@cr.rakesetu.dev`  | Ravi Menon      | commercial_officer                           |
| `freight_customer@cr.rakesetu.dev`    | Sneha Patil     | freight_customer                             |
| `ops.lead@cr.rakesetu.dev`            | Devika Nair     | freight_controller **+** terminal_supervisor |

The last account holds **two** roles. Every other seeded persona holds exactly
one, which would leave `activeRole`, the header's workspace switcher and
`handleNavigate`'s preference for it as live code with no data behind it —
DESIGN.md §4.1 allows several grants, so one account exercises that.

Aditya Cement Ltd (`ACC`) — a second, unrelated tenant:

| Email                               | Name          | Role             |
| ----------------------------------- | ------------- | ---------------- |
| `admin@acc.rakesetu.dev`            | Meera Iyer    | admin            |
| `freight_customer@acc.rakesetu.dev` | Arjun Bhosale | freight_customer |

The second tenant is not decoration. A cross-tenant isolation suite with one
tenant proves nothing — and the assertion that actually matters is that an
**admin** cannot see across the boundary, which needs two admins in two orgs.

## API

| Method | Path                                                        | Guard                                                                                                                              |
| ------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/` · `/healthz` · `/readyz` · `/health` · `/api/v1/health` | —                                                                                                                                  |
| POST   | `/api/v1/users/login`                                       | rate-limited per IP + email                                                                                                        |
| POST   | `/api/v1/users/refresh`                                     | refresh cookie (or body, for non-browser clients)                                                                                  |
| POST   | `/api/v1/users/logout`                                      | JWT                                                                                                                                |
| GET    | `/api/v1/users/me`                                          | JWT — returns the resolved `permissions[]`                                                                                         |
| PATCH  | `/api/v1/users/me`                                          | JWT                                                                                                                                |
| GET    | `/api/v1/users`                                             | JWT + `user:write` — creates **inactive, with no password**, and emails an invitation                                              |
| POST   | `/api/v1/users`                                             | JWT + `user:write` — creates **inactive, with no password**                                                                        |
| GET    | `/api/v1/users/:id`                                         | JWT + `user:read` — 404 across tenants                                                                                             |
| PATCH  | `/api/v1/users/:id`                                         | JWT + `user:write` — name, phone, status; `email` and `password` are refused with 422                                              |
| POST   | `/api/v1/users/:id/invite`                                  | JWT + `user:write` — re-sends, superseding the previous link; 409 once activated                                                   |
| POST   | `/api/v1/users/:id/roles`                                   | JWT + `user:write`                                                                                                                 |
| DELETE | `/api/v1/users/:id/roles/:userRoleId`                       | JWT + `user:write` — sets `status='revoked'`, never a hard delete                                                                  |
| GET    | `/api/v1/users/invitations/:token`                          | public — validates a link, returns the invitee's name                                                                              |
| POST   | `/api/v1/users/invitations/:token/accept`                   | public — sets the first password, activates the account                                                                            |
| POST   | `/api/v1/users/password/forgot`                             | public — always 200, whatever the address; never returns the link                                                                  |
| GET    | `/api/v1/users/password/reset/:token`                       | public — validates a reset link                                                                                                    |
| POST   | `/api/v1/users/password/reset/:token`                       | public — sets a new password, revokes every session                                                                                |
| GET    | `/api/v1/organizations`                                     | JWT + `admin`                                                                                                                      |
| GET    | `/api/v1/organizations/:id`                                 | JWT (own organization only)                                                                                                        |
| GET    | `/api/v1/roles`                                             | JWT + `user:read`                                                                                                                  |
| GET    | `/api/v1/audit`                                             | JWT + `audit:read`, tenant-scoped, paginated; filters `entityType`, `entityId`, `actorId`, `action`, `correlationId`, `from`, `to` |
| GET    | `/api/v1/audit/:entityType/:entityId`                       | JWT + `audit:read`, one entity's full trail                                                                                        |
| GET/POST | `/api/v1/network/stations` · PATCH `…/:code`              | `masterdata:read` / `masterdata:write`; filters `search`, `division`, `zone`                                                        |
| GET/POST | `/api/v1/network/sections` · PATCH/DELETE `…/:id`         | POST takes one section **or an array**; every write busts the cached graph                                                          |
| GET/POST | `/api/v1/network/chargeable-distances`                    | bulk POST — a tariff table arrives as a table                                                                                       |
| GET    | `/api/v1/network/distance?from=&to=&basis=`                 | `basis` is **required**: `tariff` looks up and **422s when absent**, `operational` runs Dijkstra and returns the path               |
| GET/POST/PATCH | `/api/v1/commodities` · `…/:code`                   | `class` and `minWeightCondition` are required — the rating engine reads both                                                       |
| GET/POST/PATCH | `/api/v1/wagon-types` · `…/:code`                   | global catalogue                                                                                                                   |
| GET/POST/PATCH | `/api/v1/wagons` · `…/:id`                          | tenant-scoped; filters `status`, `typeCode`, `pohDueBefore`                                                                        |
| GET/POST/PATCH | `/api/v1/rakes` · `…/:id`                           | filters `state`, `station`, `wagonType`, `division`                                                                                |
| GET    | `/api/v1/rakes/:id/composition?at=<iso>`                    | the composition valid **at that instant**, plus `getRakeConstraints`                                                               |
| PUT    | `/api/v1/rakes/:id/composition`                             | replaces it — closes the open rows and opens new ones at the same timestamp                                                        |
| GET/POST/PATCH | `/api/v1/terminals` · `…/:id`                       | `masterdata:write`; filters `type`, `stationCode`, `commodityGroup`                                                                |
| GET/POST/PATCH/DELETE | `/api/v1/embargoes` · `…/:id`                | **`embargo:write`** — the controller's, not the admin's. DELETE ends it; the row stays                                             |
| POST   | `/api/v1/embargoes/preview`                                 | the plain-English reading of a scope, from the module that matches it                                                              |
| GET/POST/PATCH | `/api/v1/customers` · `…/:id`                       | tenant-scoped on the **zone**; `customer_org_id` is the portal tenant (D7)                                                         |
| GET/POST/DELETE | `/api/v1/customers/:id/sidings` · `…/:sidingId`    | which terminals a customer may load at, and what they may load                                                                     |
| GET/POST/PATCH | `/api/v1/charge-rules` · `…/:id`                    | filters `type`, `effectiveAt` — the date predicate is SQL                                                                          |
| GET    | `/api/v1/charge-rules/resolve?type=&asOf=&…`                | the winning rule **and every rule that lost, with a reason**. `asOf` is required                                                    |
| POST   | `/api/v1/documents/upload`                                  | multipart, 50 MB cap; duplicate content in one org is a 409                                                                        |
| GET    | `/api/v1/documents`                                         | filters `type`, `isCorpus`, `search`                                                                                               |
| GET    | `/api/v1/documents/:id/download-url`                        | a 15-minute presigned URL, minted per request and **never stored**                                                                 |
| DELETE | `/api/v1/documents/:id`                                     | soft — `is_active=false`; the stored object is retained                                                                            |
| POST   | `/api/v1/rakes/:rakeId/events`                              | JWT + `rake:event:create` + `Idempotency-Key` — 201 with the new projection; **409** naming the from-state, the event and the legal set    |
| POST   | `/api/v1/rakes/:rakeId/events/bulk`                         | JWT + `rake:event:create` — all-or-nothing; each element carries its own key                                                              |
| GET    | `/api/v1/rakes/:rakeId/events`                              | JWT + `rake:read` — `occurred_at` order; `from`, `to`, `eventType`, `includeRejected`                                                     |
| GET    | `/api/v1/rakes/:rakeId/state`                               | JWT + `rake:read` — the current projection; 404 when the rake has no events                                                               |
| GET    | `/api/v1/rakes/:rakeId/cycles` · `/cycles/:cycleId`         | JWT + `rake:read`                                                                                                                        |
| POST   | `/api/v1/rakes/:rakeId/reproject`                           | JWT + `admin` — §13.2's determinism check; `{ changed: false }` is the healthy answer                                                     |
| GET    | `/api/v1/network/live`                                      | JWT + `rake:read` + an operating role — the map feed, tenant-scoped, `Cache-Control: no-store`                                            |
| GET    | `/api/v1/network/rake-states` · `/available-count`          | JWT + `rake:read` + an operating role                                                                                                    |
| GET    | `/api/v1/anomalies`                                         | JWT + `rake:read` + an operating role — refused events, kept as evidence                                                                  |

List endpoints return a fixed envelope inside `data`:

```json
{
  "data": [],
  "pagination": { "page": 1, "limit": 20, "total": 0, "totalPages": 1 }
}
```

`limit` is clamped to 100 and an unknown `?sort=` column falls back rather than
reaching SQL.

### Invitations and password resets

`POST /users` creates the row `inactive` with a null hash — which is why
`users.hash_password` is nullable — and emails an invitation. **Nobody ever sets
somebody else's password**, not even the admin creating the account: the link is
what sets one, so the credential exists only between the invitee's keyboard and
bcrypt.

Both flows share `user_tokens`, because an invitation and a reset are the same
object: a bearer secret, scoped to one user, valid until a deadline, consumable
once. The properties that matter:

- **The token is never stored** — only `sha256(token)`, as `refresh_tokens`
  does. A dump of the table is a list of digests, not a set of working links.
  32 bytes of `randomBytes`, base64url; not a UUID, which is widely assumed
  non-secret and is the wrong primitive for something that alone takes over an
  account.
- **Issuing supersedes.** A second invitation revokes the first, so a link
  forwarded to the wrong inbox dies the moment a replacement is sent.
- **Redemption is single-use.** `consume()` sets `consumed_at` only where it is
  still null and reports whether it won, so a double submit races safely.
- **One failure message.** Unknown, expired, revoked and already-used all return
  the same 400 — distinguishing them tells an attacker which guesses are close.
- **`forgot-password` always answers 200**, whether or not the address exists,
  and never returns the link. An endpoint that 404s on an unknown email is a way
  to test a leaked address list against your user base.
- **A reset cannot reactivate a suspended account.** Only the invitation type
  may touch `status`, which is why the two are distinct enum values rather than
  one "set a password" token.
- **Redeeming ends every other session**, because the usual reason to reset a
  password is that somebody else may have had it.

Mail is **asynchronous**. `InvitationService` writes an `email_jobs` row and
publishes onto `email.send`; a consumer in this process renders the template and
sends it. That is a second queue family alongside `ai.*`, on the same
connection — email is not an AI job, and `AI_JOB_KINDS` doubles as the
`ai_job_type` enum, so a fourth kind there would have been a migration and a
category error. See [DECISIONS.md D6](../docs/phases/DECISIONS.md#d6--transactional-email-transport).

Two consequences worth knowing:

- **No endpoint ever returns a link.** `POST /users` answers
  `{ queued, expiresAt, emailJobId }`. It cannot report _delivery_ — the send
  happens after the request ends — so it does not pretend to. An earlier version
  returned the URL when SMTP was unconfigured, which put a password-setting
  credential in a response body, a browser, and every log that touched either.
- **The token is in the message, never in the database.** `user_tokens` stores
  only a sha256, so the plaintext has to travel from the request that issued it
  to the consumer that renders it; it rides on the queue and expires with it.
  `EnqueueEmailInput` splits `vars` (persisted) from `secrets` (published only),
  and `createJob()` never has `secrets` in scope — the guarantee is structural.
  The trade is deliberate: a dead-lettered job **cannot be replayed from its
  row**. Recovery is Resend, which mints a fresh token anyway.

Failed sends retry **three times for an invitation and twice for a reset** — a
reset link lives an hour, so spending an invitation's budget on it would deliver
mail that is nearly dead on arrival. On exhaustion the row is marked `failed`
and the message lands in `email.send.failed`.

The six SMTP variables are **the same names college-level-backend uses** —
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_NAME`,
`SMTP_FROM_EMAIL` — so one set of credentials configures either project. TLS is
derived from the port rather than configured (465 is implicit TLS, 587 and 25
upgrade with STARTTLS): two variables to express one fact is how they end up
disagreeing.

The one deliberate difference: College-Level marks these `getRequired`, so its
process will not boot without SMTP. RakeSetu keeps them optional because the
test suite runs with `SMTP_HOST` unset — a required variable there would mean
either a crash at boot or a suite that opens real SMTP connections.

`.env` currently points at a **real relay**, so invitations reach real inboxes —
including whatever address is typed into "Add user". Gmail rewrites the From
address to the authenticated account unless it is a verified alias, which is why
`SMTP_FROM_EMAIL` matches `SMTP_USER`.

For a sandbox instead, `docker compose up -d mailpit` gives a real SMTP server
with a web inbox at **http://localhost:8026** that accepts everything and
forwards nothing; point `SMTP_HOST=localhost`, `SMTP_PORT=1026` at it and clear
the credentials. Either way the code path is identical — which is the point.

A missing `SMTP_HOST` is a **misconfiguration**, not a mode: the job is marked
`failed` saying so, because recording it as sent would make `email_jobs` lie
about the one thing it exists to record.

One thing the user-administration endpoints deliberately will not do:

- **Change an email.** It is the login identity, and changing it silently moves
  an account to a different person. The validator refuses the field outright
  rather than dropping it, because a client that sends `email` and gets a 200
  has every reason to believe the email changed.

Neither can they escape their tenant. `orgId` in a create body is not sanitised
or rejected — `ScopedRepository.insert` spreads the caller's values first and the
bound `orgId` second, so it is structurally overwritten.

Every response uses the same envelope:

```json
{ "statusCode": 200, "data": {}, "message": "…", "success": true }
```

Errors add an `errors` array of `{ field: message }` objects, and a `stack` in
development only.

### Auth model

- Access token (15 m) and refresh token (7 d), both signed HS256.
- **The refresh token is only ever a cookie** — `httpOnly`, `SameSite=Strict`,
  `Secure` in production — and is not returned in any response body. Page
  JavaScript cannot read it, so it cannot end up in `localStorage` via
  redux-persist. The access token stays in the body for the `Bearer` fallback.
- Every issued refresh token is stored in `refresh_tokens` as `sha256(token)`,
  never in plaintext, and grouped into a **family**. Logout revokes the row, so
  the session genuinely ends rather than the browser merely forgetting it — a
  captured token stops working. Rotation and reuse detection are Phase 13; the
  family column is here now because retrofitting it later is the expensive part.
- Every refresh token carries a `jti`, so two logins in the same second (two
  tabs, a retried request) produce distinct tokens instead of colliding on the
  `token_hash` unique index.
- Five wrong passwords lock the account for 15 minutes
  (`users.failed_login_attempts` / `users.locked_until`). A separate limiter
  keyed on **IP + email** catches the opposite attack — one common password
  sprayed across many accounts, where nothing ever locks.
- `refresh` re-reads the user from the database rather than trusting the token,
  so a suspended account cannot mint a new access token.

### Permissions

`requireRoles("commercial_officer")` answers "is this person a claims officer?".
`requirePermission("charge:waive")` answers "may this request waive a charge?" —
which is the question that survives a second role needing to do the same thing.

`src/constants/permission.constants.ts` holds 24 permission strings and the
role → permissions map. It is code rather than a table on purpose: nothing in the
product lets an admin edit it, so a table would be a table of constants with a
migration in front of it. As code, a typo is a compile error and the whole map is
diffable in review. If per-tenant customisation ever appears, the map becomes the
seed for that table and no call site changes.

### Idempotency

`idempotent()` on an event-creating POST requires an `Idempotency-Key` header and
keys Redis on `sha256(orgId + method + path + key)`. Three states:

| State     | Response                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| absent    | claim the key, run the handler                                                                                                    |
| in flight | **409** — the first request has not answered, so there is nothing to replay and re-running it is the double-write being prevented |
| completed | replay the stored status and body verbatim, with `Idempotent-Replay: true`                                                        |

A failed request releases the key, so a retry actually runs. Phase 4's
`rake_events.idempotency_key` is the durable second line of defence: Redis is
fast and forgets after a day; a unique index cannot be flushed.

## Messaging (RabbitMQ)

Every AI call is asynchronous (DESIGN.md §3): the backend publishes a job, the
AI service does the model work and writes back. Nothing on the request path
waits for an LLM, so **a GenAI outage degrades the product, never breaks it**.

```
                  ┌──ai.extraction──▶ ai.extraction   ──nack──┐
publish ─▶ ai.exchange ─ai.explanation▶ ai.explanation ──nack──┤
   (direct)        └──ai.ingest──────▶ ai.ingest       ──nack──┤
                                                               ▼
                                                            ai.dlx
                                                               │
                                     ai.<kind>.failed ◀────────┘
```

- **One dead-letter queue per consumer**, so a poisoned extraction message can
  never stall explanations. A handler that throws — or content that will not
  parse — is nacked _without requeue_ and lands in `ai.<kind>.failed` rather
  than looping at the head of the queue.
- Messages are `persistent`, queues `durable`, prefetch `1`, TTL 24 h.
- `correlationId` threads request → queue → AI call through the logs.

| Piece                         | File                                            |
| ----------------------------- | ----------------------------------------------- |
| Topology + message contracts  | `src/types/queue.types.ts`                      |
| Connection, publish, consume  | `src/utils/rabbitmq.ts`                         |
| Producer + status transitions | `src/modules/ai-job/services/ai-job.service.ts` |
| Wiring + graceful close       | `src/app.ts`, `src/index.ts`                    |

The backend is the **producer** (DESIGN.md §3). Call `enqueue` — it writes the
`ai_jobs` row and publishes its id in one step, because publishing an id with no
row behind it gives the consumer nothing to write back to:

```ts
const job = await aiJobService.enqueue({
  orgId,
  type: "explanation",
  subjectType: "detention",
  subjectId: detentionId,
  payload: {
    subject: "detention",
    subjectId: detentionId,
    facts, // what the deterministic engine already computed
  },
});
```

`type` and `payload` are a discriminated union, so a row typed `extraction`
carrying an explanation payload does not compile — that combination would
publish onto a routing key no consumer for it is bound to.

The row is inserted _before_ the publish. If the publish then fails the row is
marked `failed` with the error, which is visible and replayable; the reverse
order loses the job entirely.

### Two switches worth knowing

- `USE_RABBITMQ_SERVICE=false` — no broker is contacted at all; `publishAiJob`
  runs the handler inline instead. This is what a serverless host (Vercel)
  needs, since it cannot keep an always-on consumer alive.
- `RABBITMQ_CONSUME_AI_JOBS=false` — this process becomes producer-only. Set it
  once **rakesetu-ai-ml** exists; until then a placeholder consumer here
  acknowledges and logs jobs so they do not pile up in the broker.

### Verifying the broker

```bash
npm run queue:check
```

Asserts three things: the topology is bound, `enqueue` writes an `ai_jobs` row
and publishes its id, and the placeholder consumer closes the loop — leaving
three rows in `succeeded`. That last one is what makes it an assertion about the
database and not only about the broker.

It listens on its own exclusive queue, so it gives the same answer whether or not
`npm run dev` is running alongside it. The management UI is at
<http://localhost:15674> (guest / guest) when using the compose broker.

## Environment variables

| Variable                    | Required     | Default                  | Description                                       |
| --------------------------- | ------------ | ------------------------ | ------------------------------------------------- |
| `NODE_ENV`                  | no           | `development`            | `development` / `test` / `staging` / `production` |
| `PORT`                      | no           | `4000`                   | HTTP port                                         |
| `APP_NAME`                  | no           | `rakesetu-backend`       | App identifier                                    |
| `DB_HOST`                   | yes          | —                        | Postgres host                                     |
| `DB_PORT`                   | no           | `5432`                   | Postgres port (`55433` for docker compose)        |
| `DB_NAME`                   | yes          | —                        | Database name                                     |
| `DB_USER`                   | yes          | —                        | Database user                                     |
| `DB_PASSWORD`               | yes          | —                        | Database password                                 |
| `DB_SSL`                    | no           | on in production         | TLS to Postgres                                   |
| `INSTANCE_ID`               | no           | `local`                  | Returned as the `X-Instance-Id` header            |
| `USE_RABBITMQ_SERVICE`      | no           | `true`                   | `false` runs AI jobs inline, no broker            |
| `RABBITMQ_URL`              | when enabled | —                        | e.g. `amqp://guest:guest@localhost:5674`          |
| `RABBITMQ_CONSUME_AI_JOBS`  | no           | `true`                   | `false` = producer only                           |
| `RABBITMQ_PREFETCH`         | no           | `1`                      | Unacked messages per consumer                     |
| `REDIS_URL`                 | no           | `redis://localhost:6379` | Idempotency keys, locks, later the ETA cache      |
| `REDIS_KEY_PREFIX`          | no           | `rakesetu`               | Namespaces every key this service writes          |
| `RATE_LIMIT_WINDOW_MINUTES` | no           | `15`                     | Rate-limit window                                 |
| `RATE_LIMIT_MAX`            | no           | `300`                    | Global requests per window per IP                 |
| `LOGIN_RATE_LIMIT_MAX`      | no           | `10`                     | Login attempts per window per IP + email          |
| `LOG_LEVEL`                 | no           | `debug`                  | Winston level                                     |
| `JWT_ACCESS_SECRET`         | yes          | —                        | Access token secret                               |
| `JWT_REFRESH_SECRET`        | yes          | —                        | Refresh token secret                              |
| `JWT_ACCESS_EXPIRES_IN`     | no           | `15m`                    | Access token TTL                                  |
| `JWT_REFRESH_EXPIRES_IN`    | no           | `7d`                     | Refresh token TTL                                 |
| `FRONTEND_URL`              | no           | `http://localhost:5175`  | Allowed CORS origin                               |

`.env`, `.env.staging` and `.env.production` are auto-selected by `NODE_ENV`.

## Scripts

| Script                            | What it does                                                              |
| --------------------------------- | ------------------------------------------------------------------------- |
| `npm run dev`                     | Start with nodemon (hot reload)                                           |
| `npm run build`                   | Compile to `dist/` via `tsconfig.build.json` (excludes tests and scripts) |
| `npm start`                       | Run the compiled production build                                         |
| `npm run lint` / `lint:fix`       | ESLint                                                                    |
| `npm run format` / `format:check` | Prettier                                                                  |
| `npm run type-check`              | `tsc --noEmit`, including the test suite and scripts                      |
| `npm test`                        | Full suite against throwaway Postgres + Redis containers                  |
| `npm run test:watch`              | The same, in watch mode                                                   |
| `npm run test:isolation`          | The cross-tenant suite only                                               |
| `npm run db:generate`             | Generate a Drizzle migration from the schema                              |
| `npm run db:migrate`              | Apply pending migrations                                                  |
| `npm run db:push`                 | Push the schema straight to the DB (dev only)                             |
| `npm run db:studio`               | Open Drizzle Studio                                                       |
| `npm run db:seed`                 | Seed tenancy **and** the master data the rest of the product reads        |
| `npm run db:seed -- --reset`      | Clear first. `--master-only` skips organizations, roles and users         |
| `npm run db:partitions`           | Create the next three months' `rake_events` partitions (idempotent; cron) |
| `npm run simulate`                | Replay freight movement into the event spine — see the quick start        |
| `npm run queue:check`             | RabbitMQ round-trip check (publish → consume)                             |

## Project structure

```
src/
  app.ts                  Express bootstrap — middleware order matters, see the file
  index.ts                Process entrypoint
  config/                 Typed env config (throws at boot on a missing var)
  constants/              Error messages · permission strings and the role map
  database/               pg Pool + Drizzle · Redis + CacheService · ScopedRepository
  logger/                 Winston · AsyncLocalStorage request context
  middlewares/            auth · role · permission · tenant · idempotency
                          request-id · rate-limit · validate · morgan · error-handler
  schema/                 Drizzle tables — enums · organization · user · role
                          audit-log · refresh-token · ai-job
  types/                  env · common (CustomRequest) · queue · pagination · tenant
  utils/                  ApiError · ApiResponse · asyncHandler · query · rabbitmq
  modules/
    user/                 Auth: login · refresh · logout · me · refresh tokens
    organization/         Tenant directory
    role/                 RBAC roles and assignments
    audit/                The append-only trail and its read API
    health/               Liveness and readiness
    ai-job/               ai_jobs producer + placeholder consumer
  test/
    global-setup.ts       Starts the Postgres and Redis containers, once
    setup-env.ts          Points the worker at them — imports nothing from src/
    setup-hooks.ts        Migrates and seeds, once per worker
    factories/ helpers/   Real rows, and loginAs()
    isolation/ suites/    The eight suites
scripts/seed.ts           Seed data
scripts/fixtures/         The two tenants, shared by the seed and the tests
scripts/queue-check.ts    RabbitMQ round-trip check
```

Each module follows the same layout:
`constants/ · controllers/ · dto/ · routes/ · services/ · types/ · validators/ · index.ts`

### Adding a table

Three registration points, and missing the third is silent:

1. `src/schema/<name>.schema.ts` — the definition
2. `src/schema/index.ts` — `export * from "./<name>.schema"`
3. `src/database/connection.ts` — the hand-listed `schema` object

Then, if it carries `org_id`, add a block to
`src/test/isolation/cross-tenant.test.ts`. That is a stated exit criterion of
every phase: a tenant-scoped table with no isolation case is a table nobody has
checked.
