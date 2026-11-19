import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, lstatSync, mkdirSync } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobStoreError, MAX_BLOB_BYTES, configuredBlobStore } from './blob-store.js';
import { inspectEvidenceImage } from './evidence-image.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BLOB_KEY = new RegExp(`^${UUID}/${UUID}/[0-9a-f]{64}$`);
const AZURE_ENV_NAMES = ['EVIDENCE_BLOB_ACCOUNT_URL', 'EVIDENCE_CONTAINER', 'THUMBNAIL_CONTAINER'];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const MAGIC = new Map([
  ['image/jpeg', JPEG_MAGIC],
  ['image/png', PNG_MAGIC],
]);
const PROCESSOR_PATH = fileURLToPath(new URL('../../functions/thumbnail/processor.cjs', import.meta.url));
const require = createRequire(import.meta.url);

let cachedThumbnailer;

function loadInstalledThumbnailer() {
  if (cachedThumbnailer !== undefined) return cachedThumbnailer;
  try {
    const mod = require(PROCESSOR_PATH);
    cachedThumbnailer = typeof mod?.makeThumbnail === 'function' ? mod.makeThumbnail : null;
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND') {
      cachedThumbnailer = null;
    } else {
      throw error;
    }
  }
  return cachedThumbnailer;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function parseKey(key) {
  if (typeof key !== 'string' || !BLOB_KEY.test(key)) throw new TypeError('Invalid blob key');
  const parts = key.split('/');
  return { caseId: parts[0], evidenceId: parts[1], sha: parts[2] };
}

function targetPath(namespaceDir, { caseId, evidenceId, sha }, suffix = '') {
  const resolved = path.resolve(namespaceDir, caseId, evidenceId, `${sha}${suffix}`);
  const prefix = namespaceDir.endsWith(path.sep) ? namespaceDir : `${namespaceDir}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new TypeError('Invalid blob key');
  return resolved;
}

function validateRootDir(rootDir) {
  if (
    typeof rootDir !== 'string'
    || rootDir.length < 1
    || rootDir.length > 4096
    || /[\0\r\n]/.test(rootDir)
    || rootDir.trim() !== rootDir
    || !path.isAbsolute(rootDir)
  ) {
    throw new TypeError('Invalid local evidence directory');
  }
  const resolved = path.resolve(rootDir);
  if (resolved === path.parse(resolved).root) throw new TypeError('Invalid local evidence directory');
  let st;
  try {
    st = lstatSync(resolved);
  } catch {
    throw new TypeError('Local evidence directory does not exist');
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new TypeError('Invalid local evidence directory');
  try {
    accessSync(resolved, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    throw new TypeError('Local evidence directory is not accessible');
  }
  return resolved;
}

function ensureNamespaceSync(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new TypeError('Invalid local evidence namespace');
}

async function ensureBucketDir(baseDir, { caseId, evidenceId }) {
  const baseStat = await lstat(baseDir);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) throw new BlobStoreError();
  const caseDir = path.join(baseDir, caseId);
  await mkdir(caseDir, { recursive: true, mode: 0o700 });
  const caseStat = await lstat(caseDir);
  if (caseStat.isSymbolicLink() || !caseStat.isDirectory()) throw new BlobStoreError();
  const evidenceDir = path.join(caseDir, evidenceId);
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const evidenceStat = await lstat(evidenceDir);
  if (evidenceStat.isSymbolicLink() || !evidenceStat.isDirectory()) throw new BlobStoreError();
  return evidenceDir;
}

async function writeAtomicCreateOnly(tmpDir, destPath, bytes) {
  const tmpPath = path.join(tmpDir, randomUUID());
  let fh;
  try {
    fh = await open(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await fh.write(bytes, offset, bytes.length - offset);
      if (bytesWritten <= 0) throw new Error('Short write');
      offset += bytesWritten;
    }
    await fh.sync();
    await fh.close();
    fh = null;
    await link(tmpPath, destPath);
  } finally {
    if (fh) {
      try { await fh.close(); } catch { /* ignore */ }
    }
    try { await unlink(tmpPath); } catch { /* ignore */ }
  }
}

async function readPrivateFile(filePath, maxBytes) {
  let fh;
  try {
    fh = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new BlobStoreError();
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size < 1 || st.size > maxBytes) throw new BlobStoreError();
    const buf = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < st.size) {
      const { bytesRead } = await fh.read(buf, offset, st.size - offset, offset);
      if (bytesRead === 0) throw new BlobStoreError();
      offset += bytesRead;
    }
    return buf;
  } catch (error) {
    if (error instanceof BlobStoreError) throw error;
    throw new BlobStoreError();
  } finally {
    try { await fh.close(); } catch { /* ignore */ }
  }
}

async function assertNoSymlinkParents(baseDir, { caseId, evidenceId }) {
  for (const dir of [baseDir, path.join(baseDir, caseId), path.join(baseDir, caseId, evidenceId)]) {
    try {
      const st = await lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new BlobStoreError();
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      if (error instanceof BlobStoreError) throw error;
      throw new BlobStoreError();
    }
  }
  return true;
}

export function createLocalEvidenceStore({ rootDir, thumbnailer = loadInstalledThumbnailer() } = {}) {
  if (thumbnailer !== null && typeof thumbnailer !== 'function') throw new TypeError('Invalid thumbnailer');
  const resolvedRoot = validateRootDir(rootDir);
  const originalDir = path.join(resolvedRoot, 'original');
  const thumbnailDir = path.join(resolvedRoot, 'thumbnail');
  const tmpDir = path.join(resolvedRoot, '.tmp');
  ensureNamespaceSync(originalDir);
  ensureNamespaceSync(thumbnailDir);
  ensureNamespaceSync(tmpDir);

  async function putThumbnail(key, bytes) {
    const parts = parseKey(key);
    if (!Buffer.isBuffer(bytes) || bytes.length < JPEG_MAGIC.length || bytes.length > MAX_BLOB_BYTES || !JPEG_MAGIC.every((b, i) => bytes[i] === b)) {
      throw new TypeError('Invalid thumbnail bytes');
    }
    try {
      await ensureBucketDir(thumbnailDir, parts);
      const dest = targetPath(thumbnailDir, parts, '.jpg');
      await writeAtomicCreateOnly(tmpDir, dest, bytes);
      return { created: true };
    } catch (error) {
      if (error?.code === 'EEXIST') return { created: false };
      throw new BlobStoreError();
    }
  }

  async function put(key, bytes, contentType) {
    const parts = parseKey(key);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_BLOB_BYTES) throw new TypeError('Invalid blob bytes');
    const magic = MAGIC.get(contentType);
    if (!magic || bytes.length < magic.length || !magic.every((b, i) => bytes[i] === b)) {
      throw new TypeError('Unsupported blob content');
    }
    const digest = sha256(bytes);
    if (digest !== parts.sha) throw new TypeError('Blob key does not match content hash');
    inspectEvidenceImage(bytes, contentType);

    try {
      await ensureBucketDir(originalDir, parts);
      const dest = targetPath(originalDir, parts);
      await writeAtomicCreateOnly(tmpDir, dest, bytes);
    } catch {
      throw new BlobStoreError();
    }

    if (thumbnailer) {
      let thumb;
      try {
        thumb = await thumbnailer(bytes, key);
      } catch (error) {
        if (error?.code === 'INVALID_IMAGE' || error?.code === 'INVALID_OBJECT_KEY') {
          thumb = null;
        } else {
          throw new BlobStoreError();
        }
      }
      if (thumb && Buffer.isBuffer(thumb.bytes)) {
        await putThumbnail(key, thumb.bytes);
      }
    }

    return { etag: `"${digest}"`, versionId: null };
  }

  async function get(key, { thumbnail = false, maxBytes = MAX_BLOB_BYTES } = {}) {
    const parts = parseKey(key);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BLOB_BYTES) throw new TypeError('Invalid max bytes');
    const baseDir = thumbnail === true ? thumbnailDir : originalDir;
    if (!(await assertNoSymlinkParents(baseDir, parts))) return null;
    const filePath = targetPath(baseDir, parts, thumbnail === true ? '.jpg' : '');
    const bytes = await readPrivateFile(filePath, maxBytes);
    if (!bytes) return null;
    if (thumbnail === true) {
      if (bytes.length < JPEG_MAGIC.length || !JPEG_MAGIC.every((b, i) => bytes[i] === b)) throw new BlobStoreError();
      return { bytes, contentType: 'image/jpeg', etag: `"${sha256(bytes)}"` };
    }
    let contentType = null;
    if (bytes.length >= PNG_MAGIC.length && PNG_MAGIC.every((b, i) => bytes[i] === b)) contentType = 'image/png';
    else if (bytes.length >= JPEG_MAGIC.length && JPEG_MAGIC.every((b, i) => bytes[i] === b)) contentType = 'image/jpeg';
    if (!contentType || sha256(bytes) !== parts.sha) throw new BlobStoreError();
    return { bytes, contentType, etag: `"${parts.sha}"` };
  }

  async function remove(key) {
    const parts = parseKey(key);
    let removed = false;
    for (const [baseDir, suffix, isOriginal] of [[originalDir, '', true], [thumbnailDir, '.jpg', false]]) {
      if (!(await assertNoSymlinkParents(baseDir, parts))) continue;
      const filePath = targetPath(baseDir, parts, suffix);
      try {
        await unlink(filePath);
        if (isOriginal) removed = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw new BlobStoreError();
      }
    }
    return removed;
  }

  return { put, get, remove, putThumbnail };
}

export function configuredLocalEvidenceStore(env = process.env) {
  if (env.EVIDENCE_LOCAL_DIR === undefined) return null;
  return createLocalEvidenceStore({ rootDir: env.EVIDENCE_LOCAL_DIR });
}

export function configuredEvidenceStore(env = process.env) {
  const hasAzure = AZURE_ENV_NAMES.some((name) => env[name] !== undefined);
  const hasLocal = env.EVIDENCE_LOCAL_DIR !== undefined;
  if (hasAzure && hasLocal) throw new TypeError('Conflicting evidence storage configuration');
  if (hasAzure) return configuredBlobStore(env);
  if (hasLocal) return configuredLocalEvidenceStore(env);
  return null;
}
