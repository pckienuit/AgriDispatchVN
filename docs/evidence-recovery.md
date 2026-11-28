# Recover pending evidence uploads

Trusted maintenance command, not an HTTP endpoint or automatic job. Uses existing `DATABASE_URL` and storage configuration from the process environment; does not load `.env` itself. Run only against an approved target. Never paste credentials in commands, logs or screenshots.

## Read-only preview

```
node server/scripts/reconcile-evidence.js --dry-run --limit 20 --min-age-ms 900000
```

Default without flags is also dry-run. Reports aggregate counts only, selects at most 20 PENDING rows older than 15 minutes, and does not contact or mutate Blob storage. Limit 1..100; minimum age 900000..86400000 ms. These are maintenance safety bounds, not claim-response deadlines.

## Apply, only after reviewing the intended target

The operation can mark invalid/missing uploads FAILED and delete their private original objects. It must not be run merely to test configuration on shared data. Confirm both DB target and storage account with the infra owner first; hostname confirmation is an error-prevention guard, not authorization.

```
node server/scripts/reconcile-evidence.js --apply --confirm-storage-host <exact-configured-account-hostname> --limit 20
```

No apply run against Azure has been performed. Missing or mismatched hostname confirmation refuses with exit 2. Exit 1 means DB/storage or cleanup errors; exit 0 means the selected batch completed without such errors, not that all remaining backlog is empty. Each row contributes to examined and exactly one of uploaded/failed/skipped/errors.

## Behavior and limits

- Only old PENDING rows qualify; UPLOADED and young rows remain untouched.
- Check private object's byte size, SHA-256, declared type, header structure and dimensions against immutable DB metadata. This does not establish full pixel decode or image authenticity.
- Valid object plus OPEN dispute becomes UPLOADED with current ETag; otherwise becomes FAILED. Missing object does not trigger DELETE.
- Lock order matches upload finalization: dispute then evidence. Concurrent maintenance runs may inspect the same candidate, but the locked status/age recheck allows one transition only. No SKIP LOCKED scheduling; this is a small sequential maintenance batch, not a distributed queue.
- Invalid or closed-case objects are removed only after a definite FAILED commit. An unknown COMMIT outcome never deletes a potentially committed upload. Storage read error leaves PENDING for retry.
- Failed deletion leaves a FAILED row and private orphan. This command selects PENDING only, so that orphan needs a separately authorized cleanup pass; rerunning does not silently delete it. Derived thumbnails are not deleted here.
- A blob larger than the REST client's cap counts as storage error and remains PENDING. Blob version ID is not recovered; the immutable content hash remains the version identity.
- Blob operations use bounded client timeouts. No overall batch deadline, scheduler, generalized retention policy or deletion of unrelated objects.

## Verification

`server/tests/integration/evidence-reconcile.test.js` uses real disposable PostgreSQL and an explicitly synthetic in-memory storage double. Checks cover valid recovery, metadata mismatch, missing/corrupt objects, case closure, outage/retry, commit uncertainty, failed cleanup, concurrent runs, batch/age bounds and CLI refusal/dry-run. This is not Azure identity/RBAC or live cleanup evidence.
