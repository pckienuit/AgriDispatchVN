import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { BlobStoreError, createBlobStore, createManagedIdentityTokenProvider, configuredBlobStore } from '../src/blob-store.js';

// All bytes, tokens and hosts here are synthetic. The stub is a local node:http server, not Azure.
const MiB = 1024 * 1024;
const UUID_A = '3f1c9a2e-7b4d-4e8f-9a1b-2c3d4e5f6a7b';
const UUID_B = '8a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11)]);
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 0x22)]);
const SHA = createHash('sha256').update(JPEG).digest('hex');
const KEY = `${UUID_A}/${UUID_B}/${SHA}`;
const TOKEN = 'synthetic-token-0001';
const SECRET_BODY = 'SYNTHETIC-PROVIDER-BODY-SECRET';
const ETAG = '"synthetic-etag-0001"';
const IDENTITY_HEADER = 'synthetic-identity-header-0001';
const SAFE_MESSAGE = 'Blob storage unavailable';
const FORBIDDEN = [TOKEN, SECRET_BODY, IDENTITY_HEADER, '127.0.0.1', 'blob.core', 'Bearer', KEY, UUID_A];

async function stub(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    res.on('error', () => {});
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      handler(req, res, seen.at(-1));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

function store(url, overrides = {}) {
  return createBlobStore({ accountUrl: url, allowLoopback: true, getToken: async () => TOKEN, timeoutMs: 1000, ...overrides });
}

function assertStorageError(error) {
  assert.ok(error instanceof BlobStoreError, 'expected BlobStoreError');
  assert.equal(error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(error.message, SAFE_MESSAGE);
  const dump = `${error.stack}\n${JSON.stringify(error)}`;
  for (const secret of FORBIDDEN) assert.ok(!dump.includes(secret), `error leaks ${secret.slice(0, 12)}`);
  return true;
}

const storageError = (e) => assertStorageError(e);

test('createBlobStore accepts only fixed Azure blob HTTPS origins and loopback in tests', () => {
  const token = async () => TOKEN;
  for (const accountUrl of ['https://acct1.blob.core.windows.net', 'https://acct1.blob.core.windows.net/']) {
    assert.doesNotThrow(() => createBlobStore({ accountUrl, getToken: token }));
  }
  const rejected = [
    'http://acct1.blob.core.windows.net',
    'https://acct1.blob.core.windows.net.evil.test',
    'https://evil.example.com',
    'https://ab.blob.core.windows.net',
    'https://abc_def.blob.core.windows.net',
    'https://acct1.blob.core.windows.net:8443',
    'https://user:pw@acct1.blob.core.windows.net',
    'https://acct1.blob.core.windows.net/container',
    'https://acct1.blob.core.windows.net/?sv=synthetic',
    'https://acct1.blob.core.windows.net/#fragment',
    'ftp://acct1.blob.core.windows.net',
    'http://127.0.0.1:10000',
    'http://localhost:10000',
    'not a url',
  ];
  for (const accountUrl of rejected) {
    assert.throws(() => createBlobStore({ accountUrl, getToken: token }), TypeError, accountUrl);
  }
  assert.throws(() => createBlobStore({ accountUrl: 'https://127.0.0.1:10000', allowLoopback: true, getToken: token }), TypeError);
  assert.throws(() => createBlobStore({ accountUrl: 'http://localhost:10000', allowLoopback: true, getToken: token }), TypeError);
  assert.doesNotThrow(() => createBlobStore({ accountUrl: 'http://127.0.0.1:10000', allowLoopback: true, getToken: token }));
});

test('createBlobStore requires distinct valid containers, token callback and bounded timeout', () => {
  const accountUrl = 'https://acct1.blob.core.windows.net';
  const getToken = async () => TOKEN;
  assert.throws(() => createBlobStore({ accountUrl, getToken, inputContainer: 'evidence', thumbnailContainer: 'evidence' }), TypeError);
  for (const name of ['Evidence', 'ev', 'a--b', 'a_b', '-abc', 'abc-', '', 'a'.repeat(64)]) {
    assert.throws(() => createBlobStore({ accountUrl, getToken, inputContainer: name }), TypeError, name);
    assert.throws(() => createBlobStore({ accountUrl, getToken, thumbnailContainer: name }), TypeError, name);
  }
  assert.throws(() => createBlobStore({ accountUrl }), TypeError);
  assert.throws(() => createBlobStore({ accountUrl, getToken: 'not-a-function' }), TypeError);
  for (const timeoutMs of [0, 60001, 1.5, '100']) {
    assert.throws(() => createBlobStore({ accountUrl, getToken, timeoutMs }), TypeError, String(timeoutMs));
  }
  assert.doesNotThrow(() => createBlobStore({ accountUrl, getToken, inputContainer: 'evidence-v2', thumbnailContainer: 'thumbnails' }));
});

test('blob keys accept only uuid/uuid/sha256 and never reach the network', async (t) => {
  const { url, seen } = await stub(t, (req, res) => res.sendStatus(201));
  const s = store(url);
  const bad = [
    '', `${UUID_A}/${UUID_B}`, `../${UUID_B}/${SHA}`, `${UUID_A}/${UUID_B}/${SHA.toUpperCase()}`,
    `${UUID_A.toUpperCase()}/${UUID_B}/${SHA}`, `${UUID_A}/${UUID_B}/${SHA}?x=1`, `${UUID_A}/${UUID_B}/${SHA}/extra`,
    `${UUID_A}%2F${UUID_B}/${SHA}`, `${UUID_A}/${UUID_B}/${SHA}%2e%2e`, `${UUID_A}/${UUID_B}/${SHA}.jpg`,
    `${UUID_A}/${UUID_B}/${SHA} `, `${UUID_A}/${UUID_B}/${SHA.slice(0, 63)}`,
  ];
  for (const key of bad) {
    await assert.rejects(s.put(key, JPEG, 'image/jpeg'), TypeError, `put ${key}`);
    await assert.rejects(s.get(key), TypeError, `get ${key}`);
    await assert.rejects(s.remove(key), TypeError, `remove ${key}`);
  }
  await assert.rejects(s.get(`${KEY}.jpg`, { thumbnail: true }), TypeError);
  assert.equal(seen.length, 0);
});

test('put rejects wrong type, bad bytes and oversize before any request', async (t) => {
  const { url, seen } = await stub(t, (req, res) => res.sendStatus(201));
  const s = store(url);
  const cases = [
    [JPEG, 'image/gif'], [JPEG, 'text/html'], [JPEG, 'image/jpeg; charset=utf-8'],
    [PNG, 'image/jpeg'], [JPEG, 'image/png'], [Buffer.from('<html>'), 'image/png'],
    [Buffer.alloc(0), 'image/jpeg'], [new Uint8Array(JPEG), 'image/jpeg'],
    [Buffer.concat([JPEG, Buffer.alloc(5 * MiB)]), 'image/jpeg'],
  ];
  for (const [bytes, type] of cases) {
    await assert.rejects(s.put(KEY, bytes, type), TypeError, `${type} ${bytes.length}`);
  }
  assert.equal(seen.length, 0);
});

test('put sends create-only private PUT and returns etag with null version', async (t) => {
  const { url, seen } = await stub(t, (req, res) => res.writeHead(201, { ETag: ETAG }).end());
  const result = await store(url).put(KEY, JPEG, 'image/jpeg');
  assert.deepEqual(result, { etag: ETAG, versionId: null });
  const [req] = seen;
  assert.equal(req.method, 'PUT');
  assert.equal(req.path, `/evidence/${KEY}`);
  assert.equal(req.headers['x-ms-blob-type'], 'BlockBlob');
  assert.equal(req.headers['if-none-match'], '*');
  assert.equal(req.headers['content-type'], 'image/jpeg');
  assert.equal(req.headers['x-ms-version'], '2026-04-06');
  assert.ok(req.headers['x-ms-date'], 'x-ms-date missing');
  assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(req.headers['content-length'], String(JPEG.length));
  assert.ok(req.body.equals(JPEG));
});

test('put accepts exactly 5 MiB PNG and reports version id when provider sends one', async (t) => {
  const big = Buffer.concat([PNG, Buffer.alloc(5 * MiB - PNG.length)]);
  const { url, seen } = await stub(t, (req, res) => res.writeHead(201, { ETag: ETAG, 'x-ms-version-id': '2026-11-18T00:00:00.0000000Z' }).end());
  const result = await store(url).put(KEY, big, 'image/png');
  assert.deepEqual(result, { etag: ETAG, versionId: '2026-11-18T00:00:00.0000000Z' });
  assert.equal(seen[0].headers['content-type'], 'image/png');
  assert.equal(seen[0].body.length, 5 * MiB);
});

test('put treats any status other than 201, including 409 and 412, as failure', async (t) => {
  let status = 201;
  const { url } = await stub(t, (req, res) => res.writeHead(status, { ETag: ETAG }).end(SECRET_BODY));
  for (const code of [200, 202, 204, 400, 403, 409, 412, 500]) {
    status = code;
    await assert.rejects(store(url).put(KEY, JPEG, 'image/jpeg'), storageError, `status ${code}`);
  }
});

test('put fails when etag is missing or unbounded', async (t) => {
  let headers = {};
  const { url } = await stub(t, (req, res) => res.writeHead(201, headers).end());
  await assert.rejects(store(url).put(KEY, JPEG, 'image/jpeg'), storageError);
  headers = { ETag: 'x'.repeat(300) };
  await assert.rejects(store(url).put(KEY, JPEG, 'image/jpeg'), storageError);
});

test('get reads private original with bearer and returns bytes, type and etag', async (t) => {
  const { url, seen } = await stub(t, (req, res) => res.writeHead(200, { 'Content-Type': 'image/jpeg', ETag: ETAG }).end(JPEG));
  const result = await store(url).get(KEY);
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.etag, ETAG);
  assert.ok(result.bytes.equals(JPEG));
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].path, `/evidence/${KEY}`);
  assert.equal(seen[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].headers['x-ms-version'], '2026-04-06');
});

test('get thumbnail reads sibling key plus .jpg from thumbnails container', async (t) => {
  const { url, seen } = await stub(t, (req, res) => res.writeHead(200, { 'Content-Type': 'image/jpeg', ETag: ETAG }).end(JPEG));
  await store(url).get(KEY, { thumbnail: true });
  assert.equal(seen[0].path, `/thumbnails/${KEY}.jpg`);
});

test('get returns null only for absent blob and fails on other statuses', async (t) => {
  let status = 404;
  let headers = {};
  const { url } = await stub(t, (req, res) => res.writeHead(status, { 'Content-Type': 'application/xml', ...headers }).end(SECRET_BODY));
  assert.equal(await store(url).get(KEY), null);
  assert.equal(await store(url).get(KEY, { thumbnail: true }), null);
  for (const code of [403, 409, 500]) {
    status = code;
    await assert.rejects(store(url).get(KEY), storageError, `status ${code}`);
  }
  status = 200;
  headers = { 'Content-Type': 'image/jpeg' };
  await assert.rejects(store(url).get(KEY), storageError, 'missing etag');
});

test('get refuses a declared Content-Length over maxBytes before reading the body', async (t) => {
  const { url } = await stub(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', ETag: ETAG, 'Content-Length': String(5 * MiB + 1) });
    res.write(Buffer.alloc(1024));
  });
  await assert.rejects(store(url).get(KEY), storageError, 'declared over default cap');
});

test('get refuses chunked bodies that exceed maxBytes and rejects invalid caps', async (t) => {
  const { url } = await stub(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', ETag: ETAG });
    for (let i = 0; i < 6; i++) res.write(Buffer.alloc(MiB));
    res.end();
  });
  const s = store(url);
  await assert.rejects(s.get(KEY), storageError, 'chunked over default 5 MiB cap');
  await assert.rejects(s.get(KEY, { maxBytes: 10 }), storageError, 'small cap');
  for (const maxBytes of [0, 1.5, 5 * MiB + 1, '10']) {
    await assert.rejects(s.get(KEY, { maxBytes }), TypeError, String(maxBytes));
  }
});

test('get enforces maxBytes on chunked body and returns exact-cap body', async (t) => {
  const { url } = await stub(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', ETag: ETAG });
    res.end(JPEG);
  });
  await assert.rejects(store(url).get(KEY, { maxBytes: JPEG.length - 1 }), storageError);
  const exact = await store(url).get(KEY, { maxBytes: JPEG.length });
  assert.ok(exact.bytes.equals(JPEG));
});

test('redirects are never followed', async (t) => {
  const target = await stub(t, (req, res) => res.writeHead(200, { ETag: ETAG }).end(JPEG));
  const { url, seen } = await stub(t, (req, res) => res.writeHead(302, { Location: `${target.url}/evidence/${KEY}` }).end());
  await assert.rejects(store(url).get(KEY), storageError);
  await assert.rejects(store(url).put(KEY, JPEG, 'image/jpeg'), storageError);
  assert.equal(seen.length, 2);
  assert.equal(target.seen.length, 0);
});

test('stalled response headers time out within the bound', async (t) => {
  const { url } = await stub(t, () => {});
  const started = Date.now();
  await assert.rejects(store(url, { timeoutMs: 100 }).get(KEY), storageError);
  assert.ok(Date.now() - started < 3000, 'header timeout not bounded');
});

test('stalled body times out within the same bound', async (t) => {
  const { url } = await stub(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', ETag: ETAG, 'Content-Length': '10' });
    res.write(Buffer.alloc(2));
  });
  const started = Date.now();
  await assert.rejects(store(url, { timeoutMs: 100 }).get(KEY), storageError);
  assert.ok(Date.now() - started < 3000, 'body timeout not bounded');
});

test('token resolver that ignores the signal is still bounded', async (t) => {
  const { url, seen } = await stub(t, (req, res) => res.sendStatus(201));
  const s = createBlobStore({ accountUrl: url, allowLoopback: true, timeoutMs: 100, getToken: () => new Promise(() => {}) });
  const started = Date.now();
  await assert.rejects(s.put(KEY, JPEG, 'image/jpeg'), storageError);
  assert.ok(Date.now() - started < 3000, 'token timeout not bounded');
  assert.equal(seen.length, 0);
});

test('token resolver receives the operation signal', async (t) => {
  const { url, seen } = await stub(t, (req, res) => res.sendStatus(201));
  const s = createBlobStore({
    accountUrl: url,
    allowLoopback: true,
    timeoutMs: 100,
    getToken: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  await assert.rejects(s.get(KEY), storageError);
  assert.equal(seen.length, 0);
});

test('invalid or rejected tokens fail before or at the provider without leaking', async (t) => {
  const { url, seen } = await stub(t, (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end(SECRET_BODY);
    return res.writeHead(200, { 'Content-Type': 'image/jpeg', ETag: ETAG }).end(JPEG);
  });
  for (const token of [123, null, '', 'bad\r\nX-Evil: 1', 'x'.repeat(16385)]) {
    await assert.rejects(store(url, { getToken: async () => token }).get(KEY), storageError, String(token).slice(0, 12));
  }
  await assert.rejects(store(url, { getToken: async () => 'wrong-token-0002' }).get(KEY), storageError);
  assert.equal(seen.length, 1, 'only the wrong-token request reaches the stub');
  assert.ok((await store(url, { getToken: async () => TOKEN }).get(KEY)).bytes.equals(JPEG));
});

test('remove deletes original, treats 404 as absent and fails on other errors', async (t) => {
  let status = 202;
  const { url, seen } = await stub(t, (req, res) => res.writeHead(status).end(SECRET_BODY));
  assert.equal(await store(url).remove(KEY), true);
  status = 204;
  assert.equal(await store(url).remove(KEY), true);
  status = 404;
  assert.equal(await store(url).remove(KEY), false);
  status = 500;
  await assert.rejects(store(url).remove(KEY), storageError);
  status = 409;
  await assert.rejects(store(url).remove(KEY), storageError);
  assert.equal(seen[0].method, 'DELETE');
  assert.equal(seen[0].path, `/evidence/${KEY}`);
  assert.equal(seen[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('managed identity provider sends bounded private token request and caches', async (t) => {
  let expires = Math.floor(Date.now() / 1000) + 3600;
  const { url, seen } = await stub(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'synthetic-msi-token-0001', expires_on: String(expires), token_type: 'Bearer' }));
  });
  const getToken = createManagedIdentityTokenProvider({ endpoint: `${url}/msi/token`, identityHeader: IDENTITY_HEADER, timeoutMs: 1000 });
  assert.equal(await getToken(), 'synthetic-msi-token-0001');
  assert.equal(await getToken(), 'synthetic-msi-token-0001');
  assert.equal(seen.length, 1, 'valid token must be cached');
  const [req] = seen;
  const parsed = new URL(req.path, 'http://127.0.0.1');
  assert.equal(req.method, 'GET');
  assert.equal(parsed.pathname, '/msi/token');
  assert.equal(parsed.searchParams.get('resource'), 'https://storage.azure.com/');
  assert.equal(parsed.searchParams.get('api-version'), '2019-08-01');
  assert.equal(req.headers['x-identity-header'], IDENTITY_HEADER);
  expires = Math.floor(Date.now() / 1000) + 30;
  const short = createManagedIdentityTokenProvider({ endpoint: `${url}/msi/token`, identityHeader: IDENTITY_HEADER, timeoutMs: 1000 });
  await short();
  await short();
  assert.equal(seen.length, 3, 'token inside 60s margin must not be cached');
});

test('managed identity provider single-flights concurrent refresh', async (t) => {
  const { url, seen } = await stub(t, (req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'synthetic-msi-token-0001', expires_on: Math.floor(Date.now() / 1000) + 3600 }));
    }, 50);
  });
  const getToken = createManagedIdentityTokenProvider({ endpoint: `${url}/msi/token`, identityHeader: IDENTITY_HEADER, timeoutMs: 1000 });
  const tokens = await Promise.all([getToken(), getToken(), getToken()]);
  assert.deepEqual(tokens, ['synthetic-msi-token-0001', 'synthetic-msi-token-0001', 'synthetic-msi-token-0001']);
  assert.equal(seen.length, 1);
});

test('managed identity provider rejects redirects, oversize, malformed and unsafe payloads', async (t) => {
  let respond = () => {};
  const { url } = await stub(t, (req, res) => respond(res));
  const getToken = createManagedIdentityTokenProvider({ endpoint: `${url}/msi/token`, identityHeader: IDENTITY_HEADER, timeoutMs: 1000 });
  const cases = [
    (res) => res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' }).end(),
    (res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(`{"access_token":"${'a'.repeat(40 * 1024)}","expires_on":"9999999999"}`),
    (res) => res.writeHead(200).end('not json'),
    (res) => res.writeHead(200).end(JSON.stringify({ expires_on: '9999999999' })),
    (res) => res.writeHead(200).end(JSON.stringify({ access_token: 'bad\r\nX: 1', expires_on: '9999999999' })),
    (res) => res.writeHead(200).end(JSON.stringify({ access_token: 'synthetic-msi-token-0001', expires_on: 'soon' })),
    (res) => res.writeHead(200).end(JSON.stringify({ access_token: 'synthetic-msi-token-0001', expires_on: '1' })),
    (res) => res.writeHead(500).end(SECRET_BODY),
  ];
  for (const respondCase of cases) {
    respond = respondCase;
    await assert.rejects(getToken(), storageError);
  }
});

test('managed identity provider validates endpoint and header at startup', () => {
  const base = { identityHeader: IDENTITY_HEADER };
  for (const endpoint of ['ftp://127.0.0.1/msi/token', 'http://user:pw@127.0.0.1/msi/token', 'http://127.0.0.1/msi/token#x', 'not a url']) {
    assert.throws(() => createManagedIdentityTokenProvider({ ...base, endpoint }), TypeError, endpoint);
  }
  for (const identityHeader of ['', 'bad\r\nX: 1']) {
    assert.throws(() => createManagedIdentityTokenProvider({ endpoint: 'http://127.0.0.1/msi/token', identityHeader }), TypeError);
  }
  assert.doesNotThrow(() => createManagedIdentityTokenProvider({ endpoint: 'http://127.0.0.1:12342/msi/token', identityHeader: IDENTITY_HEADER }));
});

test('storage configuration is absent or complete, never a silent local fallback',()=>{
  assert.equal(configuredBlobStore({}),null);
  for(const env of [
    {EVIDENCE_BLOB_ACCOUNT_URL:'https://acct1.blob.core.windows.net'},
    {EVIDENCE_CONTAINER:'evidence'},
    {EVIDENCE_BLOB_ACCOUNT_URL:'http://127.0.0.1:10000',IDENTITY_ENDPOINT:'http://127.0.0.1:1234/token',IDENTITY_HEADER:'synthetic'},
  ])assert.throws(()=>configuredBlobStore(env),TypeError);
  const store=configuredBlobStore({EVIDENCE_BLOB_ACCOUNT_URL:'https://acct1.blob.core.windows.net',IDENTITY_ENDPOINT:'http://127.0.0.1:1234/token',IDENTITY_HEADER:'synthetic'});
  assert.equal(typeof store.put,'function');
});
