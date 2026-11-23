import { Buffer } from 'node:buffer';

const { AbortController } = globalThis;

// ponytail: REST over fetch, no SDK, no retries, no SAS. Upgrade path: @azure/storage-blob only if listing or SAS is needed.
export const STORAGE_API_VERSION = '2026-04-06';
export const MAX_BLOB_BYTES = 5 * 1024 * 1024;
export function configuredBlobStore(env) {
  const names=['EVIDENCE_BLOB_ACCOUNT_URL','EVIDENCE_CONTAINER','THUMBNAIL_CONTAINER'];
  if(!names.some(name=>env[name]!==undefined))return null;
  if(!env.EVIDENCE_BLOB_ACCOUNT_URL||!env.IDENTITY_ENDPOINT||!env.IDENTITY_HEADER)throw new TypeError('Incomplete evidence storage configuration');
  return createBlobStore({accountUrl:env.EVIDENCE_BLOB_ACCOUNT_URL,
    inputContainer:env.EVIDENCE_CONTAINER??'evidence',thumbnailContainer:env.THUMBNAIL_CONTAINER??'thumbnails',
    getToken:createManagedIdentityTokenProvider({endpoint:env.IDENTITY_ENDPOINT,identityHeader:env.IDENTITY_HEADER})});
}
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_TIMEOUT_MS = 10000;
const TOKEN_MAX_LENGTH = 16384;
const ETAG_MAX_LENGTH = 256;
const VERSION_ID_MAX_LENGTH = 256;
const IDENTITY_HEADER_MAX_LENGTH = 1024;
const IDENTITY_JSON_MAX_BYTES = 32 * 1024;
const IDENTITY_API_VERSION = '2019-08-01';
const STORAGE_RESOURCE = 'https://storage.azure.com/';
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
const HOSTNAME = /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/;
const CONTAINER = /^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BLOB_KEY = new RegExp(`^${UUID}/${UUID}/[0-9a-f]{64}$`);
const MAGIC = new Map([
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
]);

export class BlobStoreError extends Error {
  constructor() {
    super('Blob storage unavailable');
    this.name = 'BlobStoreError';
    this.code = 'STORAGE_UNAVAILABLE';
  }
}

function invalid(message) {
  return new TypeError(message);
}

function validateTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw invalid('Invalid blob timeout');
}

function validateAccountUrl(value, allowLoopback) {
  if (typeof value !== 'string') throw invalid('Invalid blob account URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid('Invalid blob account URL');
  }
  const loopback = allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  const azure = url.protocol === 'https:' && HOSTNAME.test(url.hostname) && url.port === '';
  const rootOnly = url.pathname === '/' || url.pathname === '';
  if (!(loopback || azure) || url.username || url.password || url.search || url.hash || !rootOnly) {
    throw invalid('Invalid blob account URL');
  }
  return url.origin;
}

function checkKey(key) {
  if (typeof key !== 'string' || !BLOB_KEY.test(key)) throw invalid('Invalid blob key');
}

async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Body already closed or locked; nothing left to release.
  }
}

// Caller's signal wins even if the wrapped promise ignores its own signal.
function untilAborted(signal, promise) {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new Error('aborted'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

async function readBounded(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await discard(response);
    throw new Error('Body exceeds limit');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Body exceeds limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function blobUrl(origin, container, key) {
  return new URL(`/${container}/${key}`, origin);
}

export function createBlobStore({
  accountUrl,
  inputContainer = 'evidence',
  thumbnailContainer = 'thumbnails',
  getToken,
  allowLoopback = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const origin = validateAccountUrl(accountUrl, allowLoopback === true);
  if (typeof inputContainer !== 'string' || !CONTAINER.test(inputContainer)) throw invalid('Invalid input container');
  if (typeof thumbnailContainer !== 'string' || !CONTAINER.test(thumbnailContainer)) throw invalid('Invalid thumbnail container');
  if (inputContainer === thumbnailContainer) throw invalid('Containers must differ');
  if (typeof getToken !== 'function') throw invalid('getToken must be a function');
  validateTimeout(timeoutMs);

  // One signal spans token resolution, headers and body streaming.
  async function call(operation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await operation(controller.signal);
    } catch {
      throw new BlobStoreError();
    } finally {
      clearTimeout(timer);
    }
  }

  async function authorization(signal) {
    const token = await untilAborted(signal, Promise.resolve(getToken({ signal })));
    if (typeof token !== 'string' || token.length < 1 || token.length > TOKEN_MAX_LENGTH || /[\r\n]/.test(token)) {
      throw new Error('Invalid token');
    }
    return `Bearer ${token}`;
  }

  function headers(auth, extra = {}) {
    return { Authorization: auth, 'x-ms-version': STORAGE_API_VERSION, 'x-ms-date': new Date().toUTCString(), ...extra };
  }

  async function put(key, bytes, contentType) {
    checkKey(key);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_BLOB_BYTES) throw invalid('Invalid blob bytes');
    const magic = MAGIC.get(contentType);
    if (!magic || bytes.length < magic.length || !magic.every((byte, i) => bytes[i] === byte)) {
      throw invalid('Unsupported blob content');
    }
    return call(async (signal) => {
      const auth = await authorization(signal);
      const response = await fetch(blobUrl(origin, inputContainer, key), {
        method: 'PUT',
        headers: headers(auth, { 'x-ms-blob-type': 'BlockBlob', 'If-None-Match': '*', 'Content-Type': contentType }),
        body: bytes,
        signal,
        redirect: 'error',
      });
      await discard(response);
      if (response.status !== 201) throw new Error('Unexpected status');
      const etag = response.headers.get('etag');
      if (!etag || etag.length > ETAG_MAX_LENGTH) throw new Error('Missing etag');
      const versionId = response.headers.get('x-ms-version-id');
      if (versionId !== null && (versionId.length < 1 || versionId.length > VERSION_ID_MAX_LENGTH)) throw new Error('Bad version');
      return { etag, versionId: versionId ?? null };
    });
  }

  async function get(key, { thumbnail = false, maxBytes = MAX_BLOB_BYTES } = {}) {
    checkKey(key);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BLOB_BYTES) throw invalid('Invalid max bytes');
    const container = thumbnail === true ? thumbnailContainer : inputContainer;
    const name = thumbnail === true ? `${key}.jpg` : key;
    return call(async (signal) => {
      const auth = await authorization(signal);
      const response = await fetch(blobUrl(origin, container, name), {
        method: 'GET',
        headers: headers(auth),
        signal,
        redirect: 'error',
      });
      if (response.status === 404) {
        await discard(response);
        return null;
      }
      const contentType = response.headers.get('content-type');
      const etag = response.headers.get('etag');
      if (response.status !== 200 || !MAGIC.has(contentType) || !etag || etag.length > ETAG_MAX_LENGTH) {
        await discard(response);
        throw new Error('Unexpected response');
      }
      const bytes = await readBounded(response, maxBytes);
      return { bytes, contentType, etag };
    });
  }

  async function remove(key) {
    checkKey(key);
    return call(async (signal) => {
      const auth = await authorization(signal);
      const response = await fetch(blobUrl(origin, inputContainer, key), {
        method: 'DELETE',
        headers: headers(auth),
        signal,
        redirect: 'error',
      });
      await discard(response);
      if (response.status === 404) return false;
      if (response.status === 202 || response.status === 204) return true;
      throw new Error('Unexpected status');
    });
  }

  async function putThumbnail(key,bytes) {
    checkKey(key);
    if(!Buffer.isBuffer(bytes)||bytes.length<3||bytes.length>MAX_BLOB_BYTES||bytes[0]!==0xff||bytes[1]!==0xd8)throw invalid('Invalid thumbnail bytes');
    return call(async signal=>{
      const response=await fetch(blobUrl(origin,thumbnailContainer,`${key}.jpg`),{method:'PUT',
        headers:headers(await authorization(signal),{'x-ms-blob-type':'BlockBlob','If-None-Match':'*','Content-Type':'image/jpeg'}),
        body:bytes,signal,redirect:'error'});
      await discard(response);
      if (response.status === 412 ||
          (response.status === 409 && response.headers.get('x-ms-error-code') === 'BlobAlreadyExists')) {
        return { created: false };
      }
      if(response.status!==201)throw new Error('Unexpected thumbnail status');
      return {created:true};
    });
  }
  return { put, get, remove, putThumbnail };
}

export function createManagedIdentityTokenProvider({ endpoint, identityHeader, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalid('Invalid identity endpoint');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw invalid('Invalid identity endpoint');
  }
  if (typeof identityHeader !== 'string' || identityHeader.length < 1 || identityHeader.length > IDENTITY_HEADER_MAX_LENGTH || /[\r\n]/.test(identityHeader)) {
    throw invalid('Invalid identity header');
  }
  validateTimeout(timeoutMs);
  url.searchParams.set('resource', STORAGE_RESOURCE);
  url.searchParams.set('api-version', IDENTITY_API_VERSION);

  let cached = null;
  let inflight = null;

  async function fetchToken() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { 'X-IDENTITY-HEADER': identityHeader, Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status !== 200) {
        await discard(response);
        throw new Error('Identity status');
      }
      const body = await readBounded(response, IDENTITY_JSON_MAX_BYTES);
      const json = JSON.parse(body.toString('utf8'));
      const token = json.access_token;
      const expiresOn = typeof json.expires_on === 'number' ? json.expires_on
        : typeof json.expires_on === 'string' && /^\d{1,13}$/.test(json.expires_on) ? Number(json.expires_on) : NaN;
      if (typeof token !== 'string' || token.length < 1 || token.length > TOKEN_MAX_LENGTH || /[\r\n]/.test(token) || !Number.isSafeInteger(expiresOn) || expiresOn <= 0) {
        throw new Error('Invalid identity payload');
      }
      const expiresAt = expiresOn * 1000;
      if (expiresAt <= Date.now()) throw new Error('Expired identity token');
      if (expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
        cached = { token, refreshAt: expiresAt - TOKEN_REFRESH_MARGIN_MS };
      }
      return token;
    } catch {
      throw new BlobStoreError();
    } finally {
      clearTimeout(timer);
    }
  }

  return async function getToken({ signal } = {}) {
    if (cached && Date.now() < cached.refreshAt) return cached.token;
    inflight ??= fetchToken().finally(() => { inflight = null; });
    return untilAborted(signal, inflight);
  };
}
