# Thumbnail Function

Local source checkpoint, not deployed Azure acceptance. One root package/lockfile remains; `sharp` 0.35.5 is optional for the application and required for this image. App runtime installs with `--omit=optional`; Function image checks that sharp loads. Tests are included in root `npm test`.

## Build and verify

```
npm ci
npm test
docker build -f infra/Function.Dockerfile -t agridispatch-thumbnail:local .
docker run --rm --entrypoint node agridispatch-thumbnail:local --test functions/thumbnail/processor.test.cjs functions/thumbnail/handler.test.cjs
```

Image uses official Functions v4 Node 24 base, separate from Node 26 business-service images. `function.json` uses the classic Node programming model; no second npm package or framework. The public script root places a trigger descriptor in `thumbnail/`, handler/source in `functions/thumbnail/` and shared validators in `server/src/`.

## Infrastructure settings, no values or secrets here

- `EVIDENCE_CONTAINER=evidence`, `THUMBNAIL_CONTAINER=thumbnails`, distinct private containers.
- `EvidenceSource__blobServiceUri=https://<account>.blob.core.windows.net`, `EvidenceSource__queueServiceUri=https://<account>.queue.core.windows.net` for identity-based Blob trigger connection.
- Host storage `AzureWebJobsStorage__accountName=<account>` with approved host-storage identity permissions. Do not assume read-only Blob rights suffice: trigger receipts/poison handling use host storage and queues.
- `EVIDENCE_BLOB_ACCOUNT_URL=https://<account>.blob.core.windows.net` plus platform `IDENTITY_ENDPOINT` and `IDENTITY_HEADER` for output REST writes. App Service identity endpoint contract is verified; Function-host injection of these values must be checked on actual target.
- Function identity reads evidence and writes thumbnails. Original evidence must not be publicly readable. Trigger runtime/host roles and app roles must be checked separately by infra owner; a configured role is not runtime proof.

Trigger path: `evidence/{caseId}/{evidenceId}/{sha}`. Input is immutable create-only and SHA-bound. Output: `thumbnails/{caseId}/{evidenceId}/{sha}.jpg`, separate container, create-only. Duplicate output receives 412 and is left unchanged. Immutable content hash provides the version identity; no assumption that Azure Blob versioning is enabled.

Processor: JPEG/PNG only, at most 5 MiB and 4096×4096 pixels; shared structure check then sharp decode with `failOn: warning`, 5-second libvips timeout, rotate EXIF, fit inside 320×320 without enlargement, JPEG quality 80. Metadata is removed from derived image; original remains unchanged/private. Invalid inputs log fixed rejection codes and no output. Storage failure throws a fixed error for host retry. Decoder runs in-process, not a worker sandbox.

Host timeout 30 seconds, Blob concurrency 1; queue poison handling maximum dequeue count 3. These are configured bounds, not evidence of a measured retry execution. Polling Blob trigger is chosen here; Event Grid is not silently assumed configured. Actual hosting-plan compatibility, trigger registration, managed identity, retries/poison behavior, invocation and output must be verified in the deployed environment before G9 completion.

## Evidence needed

Record deployed image digest/SHA, private input creation, invocation ID/time, output JPEG checksum/dimensions, a duplicate-trigger replay with one unchanged output, invalid-input rejection and unauthorized read denial. Keep tokens, keys, original object names/PII and connection strings out of logs/screenshots. Local processor tests do not establish Azure invocation.
