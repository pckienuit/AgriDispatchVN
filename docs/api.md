# Cloud branch API contract

Approved implementation plan: IS402 delivery for 24 November 2026. This contract describes intended behavior until implementation tests prove it. The product is a wet-hire dispatch service, not bare machine rental. No real money movement, SMS or identity certification.

## Services and transport

### Whole-package postponement

- `GET /api/bookings/:id/postponement`: actual owner only, returns `{packageId:null|UUID}` to discover its package without exposing other owners.
- `GET /api/packages/:id/postponement`: actual package owners, assigned provider/operator or coordinating coop only. Returns `{package:{id,status,startAt,endAt},permissions:{canPropose,canConsent},latest,history}`. History contains at most 20 latest immutable versions, with `version,oldStartAt,oldEndAt,startAt,endAt,reason,createdAt,requiredCount,consentedCount,ownConsented,appliedAt`. No other owner IDs or contacts. Reads are no-store and serialized with package mutations for a consistent view.
- `POST /api/packages/:id/postponement {startAt,endAt,reason}`: actual owner, assigned provider or coordinating coop proposes a new version (201); no implicit consent. Claimed package, all bookings assigned, no existing shift or blocking dispute. Start must move later than current start; UTC seconds or milliseconds with `Z`, real calendar date, positive interval at most 30 days; reason 1..500 code points. Original booking request/price snapshots remain fixed. The 30-day interval is an input bound, not an approved agronomic delay promise.
- `POST /api/packages/:id/postponement/:version/consent {}`: every distinct actual owner and provider personally consent to the latest version. Coop cannot sign for owners; an actual coop owner retains its own consent. Overlapping owner/provider parties are refused. Duplicate consent is idempotent; a stale version returns `STALE_VERSION`. Existing schedule holds until the last consent transaction rechecks machine ownership/type/availability, operator role and accepted commitment covering the new window, plus half-open resource conflicts. Failure rolls back that last consent and all schedule changes; earlier consents remain. Retry after successful application returns its history without applying twice.
- Package lock, sorted booking locks and sorted machine/operator advisory locks serialize rescheduling against claim/cancel/start, competing allocations and dispute opening. Applied versions update active allocations and package window atomically. Append-only proposal/consent/application tables preserve old windows; the DB refuses package-window changes after any shift. Reads remain available for cancelled/started packages, but no new postponement. No inferred fees, refunds, fault, timeout consent or 3–5 day deadline. Readiness flags are retained, not silently re-confirmed or reset by this operation.
- UI `#postponement/UUID` is linked from claimed packages and each owner's booking detail. Current package window is distinct from the immutable requested window; actions come from server permissions. Missing cloud deployment evidence remains separate from these local API checks.

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

### Dispute review and UI

### Private evidence API (local implementation, cloud verification pending)

- `POST /api/disputes/:id/evidence`: raw `image/png` or `image/jpeg`, at most 5 MiB, 4096 pixels per side. Only actual claimant/respondent on an OPEN case may upload. No filenames, URLs, object keys or actor fields accepted. Header/chunk structure validation is not complete pixel decoding, authenticity verification or virus scanning. The thumbnail processor must decode separately under its own limits.
- `GET /api/disputes/:id/evidence?limit&offset`: actual parties or current assigned admin mediator only, never unassigned triage admins. Returns `{items,limit,offset,canUpload,storageAvailable}`; each uploaded item has `id,status,contentType,byteSize,width,height,createdAt`. Internal storage references and contact data stay private.
- `GET /api/evidence/:id/content`: authenticated original download, attachment disposition, no-store/nosniff/sandbox, length and SHA-256 checked against DB. `GET /api/evidence/:id/thumbnail`: authenticated JPEG bytes or 404 `THUMBNAIL_PENDING`; no SAS or token in URL. Original bytes, including EXIF/GPS if present, are retained for evidence integrity and must be disclosed before real uploads; thumbnail metadata removal is separate work.
- Same actor/case/content hash replays the existing uploaded record (200); a concurrent pending duplicate returns 409 `UPLOAD_PENDING`. Ten PENDING/UPLOADED items per case is a storage-abuse cap, not survey policy. Case locks serialize reservations; upload occurs outside DB transaction, then case state is rechecked under lock before finalizing. Closure during upload marks FAILED and attempts private-object cleanup. Storage failure never returns success; failed rows remain immutable audit history.
- Crash between reservation and finalization can leave PENDING/private orphan objects; automatic reconciliation is not implemented. An uncertain final DB commit retains bytes rather than risking deletion of a successfully committed record. No deletion/replacement endpoint or automatic claim that an unresolved upload succeeded. Reconciliation and retention controls remain release gates before a real-user pilot.
- Runtime configuration: `EVIDENCE_BLOB_ACCOUNT_URL=https://<account>.blob.core.windows.net`, optional distinct `EVIDENCE_CONTAINER=evidence` and `THUMBNAIL_CONTAINER=thumbnails`; platform-managed `IDENTITY_ENDPOINT`/`IDENTITY_HEADER`. Partial configuration fails startup. No evidence configuration means upload/content routes return 503 `STORAGE_UNAVAILABLE`; no mock fallback. REST version `2026-04-06` and managed identity API `2019-08-01` are verified against Microsoft documentation, but actual RBAC/Blob invocation is still untested on Azure.
- Local integration uses real account HTTP identity, PostgreSQL and the real REST client against an explicitly synthetic local Blob protocol server. It verifies private reads, dedupe, failed storage/retry, corrupted object rejection, case closure race and concurrent item cap. The dispute detail includes evidence UI: authenticated raw upload, explicit metadata/GPS disclosure, private original downloads, on-demand thumbnails and pending/error states. Failed verification keeps upload locked until a successful list reload. Browser fixture storage is explicitly synthetic.
- `functions/thumbnail/` now contains a real sharp decoder/resize processor and Blob-trigger adapter. Derived JPEGs fit within 320×320, preserve orientation and strip metadata; original hash identifies the immutable input version. Writes are create-only to a separate thumbnail container; replay leaves the existing output unchanged. Root tests include processor/adapter tests, and local integration writes the actual generated JPEG through REST then reads it with case authorization. Official Functions Node 24 image passes these processor tests. Host trigger indexing, managed identity, actual retry/poison execution and Azure invocation are still unverified: no cloud/FaaS acceptance claimed. See [Function runbook](../functions/README.md).

- Routes `#disputes`, `#dispute/:id`, `#complaint/:bookingId` use persisted case/response/proposal history. Each party consents to the current mediator's exact proposal version. Closing unresolved retains the financial-write block, records reason/time and executes no payment or debt.
- `GET /api/dispute-review` is a bounded queue of OPEN cases for current admins with no known involvement (owner, coordinator, package coop/provider/operator, claimant/respondent). `GET /api/dispute-review/:id/mediators` returns bounded eligible admin names/IDs. Eligible admins may read OPEN detail and proposals for triage, but only assigned independent mediator may propose or close; assignment does not sign for parties. Personal case list retains its narrower party/assigned-mediator scope.
- A coop owning a booking may respond as that owner. Coordinating another owner's booking grants neither response nor consent authority. Migration 011 corrects the earlier farmer/provider-only respondent restriction without editing applied migrations.
- Local `browser-smoke.mjs --dispatch` includes UI complaint, respondent reply, admin queue/assignment/proposal, separate party consents, resolution, and second-case unresolved closure. Existing confirmed payment stays unchanged and reads remain available while writes freeze.

### Acceptance UI permissions

`GET /api/bookings/:id/acceptance` now also returns `permissions: {party,canPropose,blockedByDispute}`. `party` is `owner`, `provider` or null for a coordinating coop read. `canPropose` needs an independent assigned provider, completed shift, no current agreement and no blocking dispute. These read hints can become stale; every write still rechecks its existing transaction/ownership rules. A role label alone does not permit signing for another party.

UI `#settlement/:id` is linked from owner booking and claimed package members. Both parties consent separately to the displayed immutable version; proposal creation never auto-consents. Owner reports an external transfer using a reference; only provider acknowledgment reduces the unconfirmed balance. Unknown report outcome retains actor/booking-scoped payload in page memory, freezes editing and supports same-reference retry even when the server now reports no additional capacity. Page reload loses this memory: inspect records before creating a new report. No funds move and no bank verification occurs.

### Dispatch read contract

- UI routes `#dispatch` and `#package/:id` support coop grouping and provider machine registration/claim/cancellation. Owner delegates from `#booking/:id`; UI picks live coop names rather than entering account IDs. `GET /api/coordinators` is authenticated farmer/coop, bounded list of `{id,name}` only; names are role-directory entries, not proof of external certification. `GET /api/bookings/:id/coordinator` is owner-only and returns `{coordinatorId,canAssign}`. POST remains authoritative and refuses changing delegation after grouping.
- Local full browser path: run `server/tests/helpers/operations-browser-server.mjs --dispatch` with the disposable test variables described below, then `server/tests/browser-smoke.mjs http://127.0.0.1:33100 --dispatch`. Fixture creates accounts/accepted recruitment commitment only; owner delegation, coop grouping, machine creation, provider claim, readiness and shift lifecycle occur through UI. Browser also checks cancellation before a shift and rejection after a shift starts. This is local evidence, not cloud acceptance.

- `GET /api/dispatch/bookings`: coop only; paginated `items` contains only REQUESTED bookings explicitly delegated to the current coop. Fields: `id,fieldName,locality,serviceId,serviceName,areaM2,startAt,endAt`. No owner ID or contact details. Grouping rechecks ownership, state and compatibility transactionally.
- `GET /api/dispatch/operators`: provider only; paginated accepted commitments on the provider's jobs, retaining only users with a current operator role. Fields: `id,name,startAt,endAt,jobId`; **id is the operator account ID**, not offer ID. Same operator can appear on different jobs/windows. Listing does not prove availability; claim rechecks accepted commitment, exact window and resource conflicts.

## Observability and configuration

### In-app activity

`GET /api/activity?limit=20&offset=0` returns bounded `{items:[{id,type,createdAt,href,text}],limit,offset}` from persisted booking/recruitment/shift/dispute/remedy events. Booking events stay owner-only; job provider sees its applicants and offers, operator sees its own applications/offers; shift parties see assigned work; dispute/remedy items stay with actual parties and assigned mediator. An unassigned admin's triage access does not add private cases to its personal feed. Fixed labels omit private event bodies, contacts and names. Unknown future event types get an explicit generic detail link, not an invented outcome.

UI `#activity` includes loading/empty/error/retry and paging; links open the actual detail route. Feed has no delivery channel, unread count or read receipt. Acceptance/payment summaries remain in their existing detail views, not in this feed. Offset paging can shift when new events arrive; it is not a snapshot or guaranteed real-time notification delivery.

### Shift UI and read contract (G10b)

- Booking-owner UI shows latest readiness on `#booking/:id`. `GET /api/bookings/:id/readiness` is farmer-owner scoped and returns `{canConfirm,readiness}`; `readiness` is null before the first confirmation, otherwise includes `bookingId,drained,mature,intakeReady,confirmedAt`. Unrelated owner gets 404; non-farmer gets 403. Read permission does not grant mutation authority: POST rechecks package state and shift under lock. After shift start, UI remains read-only with recorded values. These flags are owner reports, not technical certification.

- `#shifts` lists visible shifts; assigned operators also see unstarted claimed packages. `#shift/:id` shows history and server-derived `canOperate`. Providers/coops have read-only views; API mutation ownership remains authoritative.
- `GET /api/shift-packages?limit=20&offset=0`: operator only, bounded pagination, own claimed packages without a shift. Returns `packages: [{id,locality,startAt,endAt,bookingCount,ready}]`. `ready` reflects latest owner confirmations, not a reservation: start rechecks readiness under the package lock.
- `GET /api/shifts` returns `shifts`; `GET /api/shifts/:id` returns `shift` with ordered `events`. Read DTO includes `canOperate` for the current actor. Start/pause/resume/complete write responses need not carry an operation grant; UI reloads the authorized read before showing further controls.
- `POST /api/packages/:id/shifts/start {}`; `POST /api/shifts/:id/pause {reason}`; `POST /api/shifts/:id/resume {}`; `POST /api/shifts/:id/complete {areaM2,note?}`. Only assigned operator writes. Area is integer m²; pause reason and optional note are bounded to 500 characters. Completion does not consent to acceptance or confirm payment.
- Reproduce local browser check with a disposable `TEST_DATABASE_URL` and `SYNTHETIC_LOGIN_FILE` pointing outside Git: run `node server/tests/helpers/operations-browser-server.mjs`, then `node server/tests/browser-smoke.mjs http://127.0.0.1:33100 --operations` in another terminal with the same variables. Stop fixture server with SIGTERM to close both services and drop only its generated test DB. Synthetic role grants exist only in this test fixture.

`GET /health` liveness never queries DB; both services return `X-Build-SHA` and `X-Request-ID` on responses without changing the health JSON body. `BUILD_SHA` accepts lowercase hex 7..40 characters, default `development`; Docker runtime accepts `--build-arg BUILD_SHA=<sha>` and records the declared revision in OCI label. This is deployment metadata, not proof of the source/image matching: release verification must compare the actual digest and deployed SHA.

`X-Request-ID` accepts ASCII `[A-Za-z0-9._-]{8,64}`, otherwise a UUID is generated. Booking forwards the normalized ID to account gateway and internal introspection. Default access sink emits JSON lines with service, buildSha, requestId, method, status and durationMs only; aborted connections record 499 with aborted=true. No URL/query/body/contact/header/token logging. Request ID is correlation metadata, never identity or authorization; clients must not put secrets in it. Logger failure does not break requests. Readiness still checks existing DB paths; end-to-end dependency readiness and Azure Monitor wiring remain separate cloud work.

Existing `DATABASE_URL`, `PORT`, `TEST_DATABASE_URL` retained. Planned service settings: `SERVICE_NAME`, `ACCOUNT_SERVICE_URL`, `INTERNAL_SERVICE_TOKEN`, `BUILD_SHA`; cloud storage settings chosen after Hơn checks quota/identity. Runtime must validate configured values, not silently create a default production secret.

## Verification gates

Every feature commit runs lint/unit and relevant PostgreSQL integration tests on disposable `_test` databases. Integration resets are never pointed at shared/cloud data. Concurrency tests use independent DB connections. Browser gates include keyboard, narrow/wide viewports, loading/empty/error and no false-success state. Azure completion needs deployed SHA, real persisted data and invocation/traffic evidence; a local test is not cloud acceptance.
