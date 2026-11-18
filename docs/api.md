# Cloud branch API contract

Approved implementation plan: IS402 delivery for 24 November 2026. This contract describes intended behavior until implementation tests prove it. The product is a wet-hire dispatch service, not bare machine rental. No real money movement, SMS or identity certification.

## Services and transport

- `account-service`: separate Node process, account credentials, sessions and roles. Default local port 3001.
- `booking-service`: existing Node process on port 3000; static UI and business API. This name covers dispatch, shifts and recruitment too; no third business service.
- One PostgreSQL instance for this demo. `account` owns identity tables, `dispatch` owns operational tables. Runtime roles should be restricted per schema at deployment; using one local DB login is a documented development simplification.
- JSON requests/responses, 64 KB default body bound. UTC ISO timestamps. UUID IDs. Currency in integer VND represented as decimal strings where beyond safe JSON precision; area in integer square metres. List endpoints accept bounded `limit` and `offset`.
- Failure: `{ "error": { "code": "..." } }`. 400 validation, 401 missing/expired credentials, 403 insufficient role, 404 missing/out-of-scope record, 409 conflict, 413 oversized input, 429 rate limit, 503 required dependency unavailable. Never fall back to a mock identity or success.
- Account registration creates only the unprivileged `farmer` role. Other roles require administrator approval; no public admin registration. Synthetic fixtures may contain all five roles: `farmer`, `provider`, `operator`, `coop`, `admin`.

## Account endpoints

| Method/path | Input | Result |
| --- | --- | --- |
| POST `/api/auth/register` | `email`, `password`, `name` | 201 user; duplicate 409; password minimum 12 characters, bounded to 128 |
| POST `/api/auth/login` | `email`, `password` | 200 opaque `token`, `expiresAt`, `user`; invalid credentials 401, throttled 429 |
| POST `/api/auth/logout` | Bearer token | 204, invalidate current session |
| GET `/api/me` | Bearer token | user id, name, roles; never password/hash |
| POST `/internal/introspect` | header `X-Service-Token`, JSON `token` | verified user or 401; server-to-server only |

Session tokens: cryptographically random, hash stored in DB, bounded lifetime and revocation. Passwords: `node:crypto` scrypt, fresh salt, timing-safe comparison. Login throttle stored in PostgreSQL, not per-process memory. Tokens are sent in Authorization headers; UI keeps them in memory, not URLs. No cookie authentication unless CSRF protections are explicitly added.

Booking service calls `/internal/introspect` with `ACCOUNT_SERVICE_URL`, `INTERNAL_SERVICE_TOKEN` and bounded timeout. An unavailable identity service returns 503 and no write. Invalid identity returns 401. Caller-supplied actor/owner/roles never override verified identity. Restrict internal endpoint by network and a high-entropy credential; local secret is injected by developer, not committed.

## First persistent slice

| Method/path | Access / input | Result |
| --- | --- | --- |
| GET `/api/services` | public, `limit`, `offset` | active synthetic/real-labelled service records |
| GET `/api/services/:id` | public | service details or 404 |
| GET/POST `/api/fields` | authenticated owner; name, locality, `areaM2` | own fields / persisted field |
| GET/POST `/api/machines` | provider; name, type | owned assets / new asset |
| POST `/api/bookings` | farmer/coop; `fieldId`, `serviceId`, `startAt`, `endAt`; header `Idempotency-Key` | 201 request persisted with immutable price snapshot; retry same payload/key returns original result; changed payload/key 409 |
| GET `/api/bookings` | authenticated, scoped by ownership/assignment | paginated records |
| GET `/api/bookings/:id` | authorized party | record + ordered event history |

Creating a booking is only a service request, not acceptance, dispatch or payment verification. Coop creating on behalf requires explicit field authorization; first slice may limit creation to owned fields rather than trusting arbitrary `farmerId`.

## Extended workflows

Each write is permission-checked, transactional and audited. Exact endpoint payloads are added with implementing stage tests, not guessed by UI.

- Cluster: coop groups compatible pending requests manually, opens work package; provider atomically claims it, assigns owned machine and approved operator. Serialize scheduling by resource lock; reject overlapping half-open `[startAt,endAt)` allocations. Cancellation releases allocations, retaining history.
- Shifts: assigned operator starts only after field-readiness confirmation, pauses/resumes, completes. Completion does not mark financial settlement. Actual area and incidents are recorded separately.
- Acceptance/payment records: parties accept the exact version, cannot sign for each other. Payment record describes an external transfer/acknowledgment; platform never holds or transfers funds. No timeout implies payment or debt.
- Recruitment: provider posts a job with positive capacity; operator applies; provider offers; operator accepts/declines own offer. Applications do not consume positions. Transaction locks job capacity before accepting, no over-hiring; same request cannot consume twice. Withdrawal/history retained.
- Disputes: party opens a case with evidence, other party responds; uninvolved mediator proposes versioned remedy. Independent party consent to same version is required for resolution. Unresolved closure leaves disputed obligations explicit and does not settle booking or block unrelated bookings.
- Upload: signed/authorized private object access; allowlisted file types and size, server-bound ownership, no secrets in URLs/logs retained as evidence. Thumbnail input/output prefixes differ; idempotency includes object version.

### Acceptance UI permissions

`GET /api/bookings/:id/acceptance` now also returns `permissions: {party,canPropose,blockedByDispute}`. `party` is `owner`, `provider` or null for a coordinating coop read. `canPropose` needs an independent assigned provider, completed shift, no current agreement and no blocking dispute. These read hints can become stale; every write still rechecks its existing transaction/ownership rules. A role label alone does not permit signing for another party.

### Dispatch read contract

- UI routes `#dispatch` and `#package/:id` support coop grouping and provider machine registration/claim/cancellation. Owner delegates from `#booking/:id`; UI picks live coop names rather than entering account IDs. `GET /api/coordinators` is authenticated farmer/coop, bounded list of `{id,name}` only; names are role-directory entries, not proof of external certification. `GET /api/bookings/:id/coordinator` is owner-only and returns `{coordinatorId,canAssign}`. POST remains authoritative and refuses changing delegation after grouping.
- Local full browser path: run `server/tests/helpers/operations-browser-server.mjs --dispatch` with the disposable test variables described below, then `server/tests/browser-smoke.mjs http://127.0.0.1:33100 --dispatch`. Fixture creates accounts/accepted recruitment commitment only; owner delegation, coop grouping, machine creation, provider claim, readiness and shift lifecycle occur through UI. Browser also checks cancellation before a shift and rejection after a shift starts. This is local evidence, not cloud acceptance.

- `GET /api/dispatch/bookings`: coop only; paginated `items` contains only REQUESTED bookings explicitly delegated to the current coop. Fields: `id,fieldName,locality,serviceId,serviceName,areaM2,startAt,endAt`. No owner ID or contact details. Grouping rechecks ownership, state and compatibility transactionally.
- `GET /api/dispatch/operators`: provider only; paginated accepted commitments on the provider's jobs, retaining only users with a current operator role. Fields: `id,name,startAt,endAt,jobId`; **id is the operator account ID**, not offer ID. Same operator can appear on different jobs/windows. Listing does not prove availability; claim rechecks accepted commitment, exact window and resource conflicts.

## Observability and configuration

### Shift UI and read contract (G10b)

- Booking-owner UI shows latest readiness on `#booking/:id`. `GET /api/bookings/:id/readiness` is farmer-owner scoped and returns `{canConfirm,readiness}`; `readiness` is null before the first confirmation, otherwise includes `bookingId,drained,mature,intakeReady,confirmedAt`. Unrelated owner gets 404; non-farmer gets 403. Read permission does not grant mutation authority: POST rechecks package state and shift under lock. After shift start, UI remains read-only with recorded values. These flags are owner reports, not technical certification.

- `#shifts` lists visible shifts; assigned operators also see unstarted claimed packages. `#shift/:id` shows history and server-derived `canOperate`. Providers/coops have read-only views; API mutation ownership remains authoritative.
- `GET /api/shift-packages?limit=20&offset=0`: operator only, bounded pagination, own claimed packages without a shift. Returns `packages: [{id,locality,startAt,endAt,bookingCount,ready}]`. `ready` reflects latest owner confirmations, not a reservation: start rechecks readiness under the package lock.
- `GET /api/shifts` returns `shifts`; `GET /api/shifts/:id` returns `shift` with ordered `events`. Read DTO includes `canOperate` for the current actor. Start/pause/resume/complete write responses need not carry an operation grant; UI reloads the authorized read before showing further controls.
- `POST /api/packages/:id/shifts/start {}`; `POST /api/shifts/:id/pause {reason}`; `POST /api/shifts/:id/resume {}`; `POST /api/shifts/:id/complete {areaM2,note?}`. Only assigned operator writes. Area is integer m²; pause reason and optional note are bounded to 500 characters. Completion does not consent to acceptance or confirm payment.
- Reproduce local browser check with a disposable `TEST_DATABASE_URL` and `SYNTHETIC_LOGIN_FILE` pointing outside Git: run `node server/tests/helpers/operations-browser-server.mjs`, then `node server/tests/browser-smoke.mjs http://127.0.0.1:33100 --operations` in another terminal with the same variables. Stop fixture server with SIGTERM to close both services and drop only its generated test DB. Synthetic role grants exist only in this test fixture.

`GET /health` liveness never queries DB; deployment adds build SHA. `GET /ready` checks DB and service-specific required configuration. Request ID must link cross-service operations without tokens or request bodies in logs.

Existing `DATABASE_URL`, `PORT`, `TEST_DATABASE_URL` retained. Planned service settings: `SERVICE_NAME`, `ACCOUNT_SERVICE_URL`, `INTERNAL_SERVICE_TOKEN`, `BUILD_SHA`; cloud storage settings chosen after Hơn checks quota/identity. Runtime must validate configured values, not silently create a default production secret.

## Verification gates

Every feature commit runs lint/unit and relevant PostgreSQL integration tests on disposable `_test` databases. Integration resets are never pointed at shared/cloud data. Concurrency tests use independent DB connections. Browser gates include keyboard, narrow/wide viewports, loading/empty/error and no false-success state. Azure completion needs deployed SHA, real persisted data and invocation/traffic evidence; a local test is not cloud acceptance.
