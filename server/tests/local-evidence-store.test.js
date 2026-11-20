import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BlobStoreError } from '../src/blob-store.js';
import { EvidenceImageError } from '../src/evidence-image.js';
import {
  configuredEvidenceStore,
  configuredLocalEvidenceStore,
  createLocalEvidenceStore,
} from '../src/local-evidence-store.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const MiB = 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const makeKey = (bytes, caseId = randomUUID(), evidenceId = randomUUID()) => `${caseId}/${evidenceId}/${sha256(bytes)}`;

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'local-evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function samplePng(width = 640, height = 480) {
  return sharp({ create: { width, height, channels: 3, background: { r: 20, g: 120, b: 60 } } }).png().toBuffer();
}

function exifOrientationSegment(orientation) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('MM', 0);
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = 0xe1;
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

async function sampleJpegWithExif() {
  const base = await sharp({ create: { width: 600, height: 300, channels: 3, background: { r: 80, g: 40, b: 20 } } })
    .withExif({ IFD0: { Make: 'SyntheticCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '10/1 0/1 0/1' } })
    .jpeg()
    .toBuffer();
  const oriented = await sharp({ create: { width: 600, height: 300, channels: 3, background: { r: 80, g: 40, b: 20 } } })
    .jpeg()
    .toBuffer();
  return {
    gpsJpeg: base,
    orientedJpeg: Buffer.concat([oriented.subarray(0, 2), exifOrientationSegment(6), oriented.subarray(2)]),
  };
}

function assertSafeBlobError(error, forbidden = []) {
  assert.ok(error instanceof BlobStoreError);
  assert.equal(error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(error.message, 'Blob storage unavailable');
  const dump = `${error.stack}\n${JSON.stringify(error)}`;
  for (const item of forbidden) {
    assert.equal(dump.includes(item), false, `error leaked ${item}`);
  }
  return true;
}

test('configuredEvidenceStore selects Azure or explicit local dir, never falls back or weakens Azure mode', async (t) => {
  const dir = await tempDir(t);
  assert.equal(configuredEvidenceStore({}), null);
  assert.equal(configuredLocalEvidenceStore({}), null);

  const local = configuredEvidenceStore({ EVIDENCE_LOCAL_DIR: dir });
  assert.equal(typeof local.put, 'function');
  assert.equal(typeof local.get, 'function');
  assert.equal(typeof local.remove, 'function');

  const azure = configuredEvidenceStore({
    EVIDENCE_BLOB_ACCOUNT_URL: 'https://acct1.blob.core.windows.net',
    IDENTITY_ENDPOINT: 'http://127.0.0.1:1234/token',
    IDENTITY_HEADER: 'synthetic-identity',
  });
  assert.equal(typeof azure.put, 'function');

  assert.throws(() => configuredEvidenceStore({
    EVIDENCE_BLOB_ACCOUNT_URL: 'https://acct1.blob.core.windows.net',
  }), TypeError);
  assert.throws(() => configuredEvidenceStore({
    EVIDENCE_LOCAL_DIR: dir,
    EVIDENCE_BLOB_ACCOUNT_URL: 'https://acct1.blob.core.windows.net',
    IDENTITY_ENDPOINT: 'http://127.0.0.1:1234/token',
    IDENTITY_HEADER: 'synthetic-identity',
  }), TypeError);
  assert.throws(() => configuredEvidenceStore({
    EVIDENCE_LOCAL_DIR: dir,
    EVIDENCE_CONTAINER: 'evidence',
  }), TypeError);
  assert.throws(() => configuredEvidenceStore({
    EVIDENCE_LOCAL_DIR: dir,
    THUMBNAIL_CONTAINER: 'thumbnails',
  }), TypeError);
});

test('createLocalEvidenceStore validates root directory strictly and rejects symlinks/relative/missing paths', async (t) => {
  const dir = await tempDir(t);
  const linkPath = path.join(dir, 'sym');
  const realPath = path.join(dir, 'real');
  const filePath = path.join(dir, 'file');
  await mkdir(realPath);
  await writeFile(filePath, 'x');
  await symlink(realPath, linkPath);

  for (const bad of [undefined, '', 'relative/path', ` ${realPath}`, `${realPath} `, '/', path.join(dir, 'missing'), linkPath, filePath, `${realPath}\0x`]) {
    assert.throws(() => createLocalEvidenceStore({ rootDir: bad }), TypeError, String(bad));
  }

  const roDir = path.join(dir, 'ro');
  await mkdir(roDir, { mode: 0o500 });
  if (process.getuid?.() !== 0) {
    assert.throws(() => createLocalEvidenceStore({ rootDir: roDir }), TypeError);
  }
  await chmod(roDir, 0o700);
});

test('put preserves exact original bytes, creates bounded stripped JPEG thumbnail in separate namespace, and survives restart', async (t) => {
  const dir = await tempDir(t);
  const png = await samplePng(640, 480);
  const { gpsJpeg, orientedJpeg } = await sampleJpegWithExif();
  const pngKey = makeKey(png);
  const gpsKey = makeKey(gpsJpeg);
  const orientedKey = makeKey(orientedJpeg);

  const store1 = createLocalEvidenceStore({ rootDir: dir });
  const putPng = await store1.put(pngKey, png, 'image/png');
  assert.deepEqual(putPng, { etag: `"${sha256(png)}"`, versionId: null });
  const putGps = await store1.put(gpsKey, gpsJpeg, 'image/jpeg');
  assert.deepEqual(putGps, { etag: `"${sha256(gpsJpeg)}"`, versionId: null });
  await store1.put(orientedKey, orientedJpeg, 'image/jpeg');

  const originalPath = path.join(dir, 'original', pngKey);
  const thumbnailPath = path.join(dir, 'thumbnail', `${pngKey}.jpg`);
  assert.ok((await readFile(originalPath)).equals(png));
  assert.equal((await stat(originalPath)).mode & 0o777, 0o600);
  assert.equal((await stat(thumbnailPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(dir, 'original'))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dir, 'thumbnail'))).mode & 0o777, 0o700);

  // Fresh instance simulates process restart on same persistent directory.
  const store2 = createLocalEvidenceStore({ rootDir: dir });
  const gotPng = await store2.get(pngKey);
  assert.equal(gotPng.contentType, 'image/png');
  assert.equal(gotPng.etag, `"${sha256(png)}"`);
  assert.ok(gotPng.bytes.equals(png));

  const gotGps = await store2.get(gpsKey);
  assert.equal(gotGps.contentType, 'image/jpeg');
  assert.ok(gotGps.bytes.equals(gpsJpeg), 'original EXIF bytes must remain exact');

  const pngThumb = await store2.get(pngKey, { thumbnail: true });
  assert.equal(pngThumb.contentType, 'image/jpeg');
  const pngThumbMeta = await sharp(pngThumb.bytes).metadata();
  assert.equal(pngThumbMeta.format, 'jpeg');
  assert.equal(pngThumbMeta.width, 320);
  assert.equal(pngThumbMeta.height, 240);

  const gpsThumb = await store2.get(gpsKey, { thumbnail: true });
  assert.equal(gpsThumb.contentType, 'image/jpeg');
  const gpsThumbMeta = await sharp(gpsThumb.bytes).metadata();
  assert.equal(gpsThumbMeta.format, 'jpeg');
  assert.equal(gpsThumbMeta.width, 320);
  assert.equal(gpsThumbMeta.height, 160);
  assert.equal(gpsThumbMeta.exif, undefined);
  assert.equal(gpsThumb.bytes.includes(Buffer.from('SyntheticCam', 'latin1')), false);

  const orientedThumb = await store2.get(orientedKey, { thumbnail: true });
  const orientedMeta = await sharp(orientedThumb.bytes).metadata();
  assert.equal(orientedMeta.width, 160);
  assert.equal(orientedMeta.height, 320);
  assert.equal(orientedMeta.exif, undefined);
});

test('put is atomic create-only (no overwrite) and putThumbnail replays safely without overwriting', async (t) => {
  const dir = await tempDir(t);
  const store = createLocalEvidenceStore({ rootDir: dir });
  const png = await samplePng(100, 80);
  const key = makeKey(png);

  await store.put(key, png, 'image/png');
  await assert.rejects(store.put(key, png, 'image/png'), (err) => assertSafeBlobError(err, [dir, key]));

  const firstThumb = await store.get(key, { thumbnail: true });
  const otherJpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } } }).jpeg().toBuffer();
  assert.deepEqual(await store.putThumbnail(key, otherJpeg), { created: false });
  assert.ok((await store.get(key, { thumbnail: true })).bytes.equals(firstThumb.bytes));

  const key2 = `${randomUUID()}/${randomUUID()}/${sha256(png)}`;
  assert.deepEqual(await store.putThumbnail(key2, otherJpeg), { created: true });
  assert.deepEqual(await store.putThumbnail(key2, otherJpeg), { created: false });
});

test('strict key validation, content/hash/pixel/byte bounds reject bad inputs before touching disk', async (t) => {
  const dir = await tempDir(t);
  const store = createLocalEvidenceStore({ rootDir: dir });
  const png = await samplePng(32, 32);
  const goodKey = makeKey(png);
  const [cId, eId, hex] = goodKey.split('/');

  const badKeys = [
    '', `${cId}/${eId}`, `../${eId}/${hex}`, `${cId.toUpperCase()}/${eId}/${hex}`,
    `${cId}/${eId}/${hex.toUpperCase()}`, `${goodKey}.jpg`, `${goodKey}/extra`, `${goodKey}?a=1`,
  ];
  for (const bad of badKeys) {
    await assert.rejects(store.put(bad, png, 'image/png'), TypeError);
    await assert.rejects(store.get(bad), TypeError);
    await assert.rejects(store.remove(bad), TypeError);
    await assert.rejects(store.putThumbnail(bad, Buffer.from([0xff, 0xd8, 0xff, 0xe0])), TypeError);
  }

  // Hash mismatch
  await assert.rejects(store.put(`${cId}/${eId}/${'0'.repeat(64)}`, png, 'image/png'), TypeError);
  // Type/magic mismatch and oversize
  await assert.rejects(store.put(goodKey, png, 'image/jpeg'), TypeError);
  await assert.rejects(store.put(goodKey, png, 'image/gif'), TypeError);
  const overBytes = Buffer.alloc(5 * MiB + 1, 0x89);
  await assert.rejects(store.put(makeKey(overBytes), overBytes, 'image/png'), TypeError);

  // Oversize dimensions (> 4096px)
  const tooWide = await samplePng(4097, 2);
  await assert.rejects(store.put(makeKey(tooWide), tooWide, 'image/png'), EvidenceImageError);

  // Invalid maxBytes on get
  for (const maxBytes of [0, -1, 1.5, 5 * MiB + 1, '10']) {
    await assert.rejects(store.get(goodKey, { maxBytes }), TypeError);
  }
});

test('missing thumbnailer or corrupt pixel stream preserves exact original and leaves thumbnail pending', async (t) => {
  const dir = await tempDir(t);
  const png = await samplePng(120, 90);
  const key = makeKey(png);

  const noThumbStore = createLocalEvidenceStore({ rootDir: dir, thumbnailer: null });
  await noThumbStore.put(key, png, 'image/png');
  assert.ok((await noThumbStore.get(key)).bytes.equals(png));
  assert.equal(await noThumbStore.get(key, { thumbnail: true }), null);

  // Corrupt pixel decode error from thumbnailer (`INVALID_IMAGE`) keeps original intact.
  const png2 = await samplePng(121, 90);
  const key2 = makeKey(png2);
  const rejectingStore = createLocalEvidenceStore({
    rootDir: dir,
    thumbnailer: async () => { throw Object.assign(new Error('INVALID_IMAGE'), { code: 'INVALID_IMAGE' }); },
  });
  await rejectingStore.put(key2, png2, 'image/png');
  assert.ok((await rejectingStore.get(key2)).bytes.equals(png2));
  assert.equal(await rejectingStore.get(key2, { thumbnail: true }), null);
});

test('remove deletes both original and thumbnail and symlink/corrupt disk tampering fails closed without leaks', async (t) => {
  const dir = await tempDir(t);
  const store = createLocalEvidenceStore({ rootDir: dir });
  const png = await samplePng(64, 64);
  const key = makeKey(png);

  assert.equal(await store.remove(key), false);
  await store.put(key, png, 'image/png');
  assert.equal(await store.remove(key), true);
  assert.equal(await store.get(key), null);
  assert.equal(await store.get(key, { thumbnail: true }), null);
  assert.equal(await store.remove(key), false);

  // Symlink planted in original namespace must fail closed with BlobStoreError and no path leak.
  const outsideFile = path.join(dir, 'secret.txt');
  await writeFile(outsideFile, 'do-not-read');
  const [cId, eId, hex] = key.split('/');
  const origFile = path.join(dir, 'original', cId, eId, hex);
  await symlink(outsideFile, origFile);
  await assert.rejects(store.get(key), (err) => assertSafeBlobError(err, [dir, key, outsideFile]));
  await unlinkOrIgnore(origFile);

  // Corrupt file on disk fails hash/magic check cleanly.
  await writeFile(origFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
  await assert.rejects(store.get(key), (err) => assertSafeBlobError(err, [dir, key]));
  assert.equal((await lstat(origFile)).isFile(), true);
});

async function unlinkOrIgnore(p) {
  try { await rm(p, { force: true }); } catch { /* ignore */ }
}
