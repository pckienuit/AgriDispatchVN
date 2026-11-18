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

Host timeout 30 seconds, Blob concurrency 1; `extensions.blobs.poisonBlobThreshold=3` controls Blob poison handling. `extensions.queues.maxDequeueCount` did not change the Blob retry count in the exercised extension version: the initial local probe still made 5 attempts. The corrected local host reports PoisonBlobThreshold 3 and makes 3 failed invocations before moving the message to `webjobs-blobtrigger-poison`. This is total attempts, not 3 extra retries. No fixed retry interval is promised.

Local Docker/Azurite verification: Functions host 4.1055.300.9 indexed `Host.Functions.thumbnail`, started its listener and invoked it after Blob creation. Invalid input was rejected without output; valid JPEG reached the private output write but deliberately failed because the identity endpoint was unavailable. No successful thumbnail output from this host probe is claimed. Connection-string authentication used only the official emulator development credential; identity-based EvidenceSource and managed identity were not verified. Task-owned containers and networks were removed after the probe.

Polling Blob trigger is chosen here; Event Grid is not silently assumed configured. Actual hosting-plan compatibility, managed identity, retries/poison behavior and successful private output still require verification in the deployed Azure environment before G9 completion.

### Successful local output/replay probe

A later isolated Docker run (`a6aae5`) exercised the actual Functions host with Azurite input, a synthetic identity endpoint and a synthetic HTTPS Blob output service. The container trusted only a test CA through `NODE_EXTRA_CA_CERTS`; TLS verification was not disabled. No production URL validation bypass was added.

- Invalid input: rejected with `INVALID_IMAGE`, successful handled invocation, zero output objects.
- Valid synthetic JPEG with EXIF: host invocation succeeded, output PUT returned 201.
- Reuploading the same input bytes with a new input ETag invoked the host again; output create-only PUT returned 412, handler reported `created=false`, one unchanged output remained.
- Parent independently re-read and decoded the output: JPEG 320×240, 719 bytes, no EXIF. SHA-256: `8cce7fa73426f40f2ec034ee4cad0100a6352ff88b50eef118d7dae11ae16116`.

This proves local host-to-output wiring, not Azure managed identity, RBAC or the real Blob service. Output lived on the stub's isolated bind mount, not in Azurite. Task containers/networks were removed. Raw scratch artifacts are not a durable release evidence bundle; preserve a privacy-reviewed copy with the release manifest before report freeze.

## Evidence needed

Record deployed image digest/SHA, private input creation, invocation ID/time, output JPEG checksum/dimensions, a duplicate-trigger replay with one unchanged output, invalid-input rejection and unauthorized read denial. Keep tokens, keys, original object names/PII and connection strings out of logs/screenshots. Local processor tests do not establish Azure invocation.
