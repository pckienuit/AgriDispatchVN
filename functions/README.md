# Thumbnail Function

The thumbnail Function was verified on Azure staging on 23 November 2026. Local checks below are separate from the Azure evidence. The repository uses one package and lockfile: `sharp` 0.35.5 is optional for the application (`--omit=optional`) and required for the Function image. The root `npm test` includes the Function tests.

## Azure staging verification

`func-thumbnail-bt05a1` runs Azure Functions v4 in a Docker Node 24 image in `rg-is402-agri`, Japan East, on Dedicated Linux B1 with Always On (not Consumption). The polling Blob Trigger reads the private `evidence` container. The system-assigned Managed Identity authenticates to host storage `stagrihostbt05a1` and gives the Function access to read evidence and create files in the private `thumbnails` container.

| Check, 23 November 2026 (UTC+7) | `FunctionAppLogs` invocation | Result |
| --- | --- | --- |
| Create | `588de769-2fc3-4d72-93ba-e03aff8fc57f` | `created=true`: synthetic `640x480` PNG (810,049 bytes) produced a `320x240` JPEG (14,826 bytes). |
| Blob trigger replay | `00f8640b-9827-4c4e-b5c8-05d8c56d30f1` | `created=false`; `HEAD` confirmed unchanged ETag `0x8DF48C9F42AF0A4`. |
| Three invalid fixtures | `thumbnail_rejected`, `INVALID_IMAGE` | No thumbnails created; all three output `HEAD` requests returned `404 BlobNotFound`. |

The verified Azure deployment pins `sha256:12b2fd2697d4a68cde5b7f689ad8cd199ad2d8e1c0ec1e0eb1437149b48e8a32` (`BUILD_SHA=62e445594bda68c87affef919cc5dc93ca053a05`). The repository contains the same `409 BlobAlreadyExists` handling in [`server/src/blob-store.js`](../server/src/blob-store.js), separately from that deployed build.

The record also notes a host lease loss at 22:07 on 23 November. Earlier successful invocations confirm the staging flow, not listener recovery after that entry or Azure retry/poison behavior. See [CL-09 invocation evidence](https://github.com/pckienuit/AgriDispatchVN/blob/bc46506d5ea1621425e6da701a2c9e6c81a8c909/docs/cl-09-evidence.md) and [CL-11 log evidence](https://github.com/pckienuit/AgriDispatchVN/blob/c61e6d40475bee9bf37d63361ae2b606d40e9d6b/docs/cl-11-evidence.md).

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
- `EVIDENCE_BLOB_ACCOUNT_URL=https://<account>.blob.core.windows.net` plus platform `IDENTITY_ENDPOINT` and `IDENTITY_HEADER` for output REST writes.
- Function identity reads evidence and writes thumbnails. Keep originals private. When deploying to a new environment, verify trigger/host permissions separately from output permissions at runtime.

Trigger path: `evidence/{caseId}/{evidenceId}/{sha}`. Input is immutable, create-only and SHA-bound. Output: `thumbnails/{caseId}/{evidenceId}/{sha}.jpg` in a separate container, using `If-None-Match: *`. A 412 response or Azure HTTP 409 with `x-ms-error-code: BlobAlreadyExists` returns `created=false` without overwriting; other 409 errors still fail. The content hash identifies the version without relying on Azure Blob versioning.

Processor: JPEG/PNG only, at most 5 MiB and 4096×4096 pixels; shared structure check then sharp decode with `failOn: warning`, 5-second libvips timeout, rotate EXIF, fit inside 320×320 without enlargement, JPEG quality 80. Metadata is removed from derived image; original remains unchanged/private. Invalid inputs log fixed rejection codes and no output. Storage failure throws a fixed error for host retry. Decoder runs in-process, not a worker sandbox.

Host timeout 30 seconds, Blob concurrency 1; `extensions.blobs.poisonBlobThreshold=3` controls Blob poison handling. `extensions.queues.maxDequeueCount` did not change the Blob retry count in the exercised extension version: the initial local probe still made 5 attempts. The corrected local host reports PoisonBlobThreshold 3 and makes 3 failed invocations before moving the message to `webjobs-blobtrigger-poison`. This is total attempts, not 3 extra retries. No fixed retry interval is promised.

Initial local Docker/Azurite probe: Functions host 4.1055.300.9 indexed `Host.Functions.thumbnail`, started its polling listener and invoked it after Blob creation. Invalid input produced no output. Valid JPEG reached the output write, which failed as expected because this run provided no identity endpoint. The input connection used the official emulator development credential. Test containers and networks were removed after the probe.

### Successful local output/replay probe

A later isolated Docker run (`a6aae5`) exercised the actual Functions host with Azurite input, a synthetic identity endpoint and a synthetic HTTPS Blob output service. The container trusted only a test CA through `NODE_EXTRA_CA_CERTS`; TLS verification was not disabled. No production URL validation bypass was added.

- Invalid input: rejected with `INVALID_IMAGE`, successful handled invocation, zero output objects.
- Valid synthetic JPEG with EXIF: host invocation succeeded, output PUT returned 201.
- Reuploading the same input bytes with a new input ETag invoked the host again; output create-only PUT returned 412, handler reported `created=false`, one unchanged output remained.
- Parent independently re-read and decoded the output: JPEG 320×240, 719 bytes, no EXIF. SHA-256: `8cce7fa73426f40f2ec034ee4cad0100a6352ff88b50eef118d7dae11ae16116`.

This local probe exercised host-to-output wiring with stubs. Output lived on the stub's isolated bind mount, not in Azurite. Test containers and networks were removed.

## Evidence checklist for future deployments

Record deployed image digest/SHA, private input creation, invocation ID/time, output JPEG checksum/dimensions, a duplicate-trigger replay with one unchanged output, invalid-input rejection and unauthorized read denial. Keep tokens, keys, original object names/PII and connection strings out of logs/screenshots.
