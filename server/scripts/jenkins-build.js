// Jenkins REST client and build-manifest writer used by the Azure DevOps and Jenkins pipelines.
// Usage:
//   node server/scripts/jenkins-build.js run
//     env: JENKINS_URL JENKINS_JOB JENKINS_USER JENKINS_TOKEN BUILD_SHA PUBLISH ACR_REGISTRY [JENKINS_TIMEOUT_MS]
//   node server/scripts/jenkins-build.js write-manifest <out.json>
//     env: BUILD_SHA ACR_REGISTRY PUBLISH [APP_DIGEST FUNCTION_DIGEST]   (refuses to overwrite out.json)
// Only the buildWithParameters POST sends state. Every follow-up URL must stay on the JENKINS_URL origin.
// ponytail: no retry on queue or build polling; a Jenkins restart fails the run. Ceiling: one bounded run. Upgrade: resume by queue id.
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, URLSearchParams } from 'node:url';

const { AbortSignal } = globalThis;

const MAX_BODY_BYTES = 64 * 1024;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_TIMEOUT_MS = 2_700_000;
const POLL_MS = 5_000;
const JOB_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REGISTRY_RE = /^[a-z0-9]{5,50}\.azurecr\.io$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const DISALLOWED_CRUMB_FIELDS = new Set([
  'authorization',
  'content-type',
  'host',
  'cookie',
  'content-length',
  'transfer-encoding',
  'connection',
  'accept',
]);
const ALLOWED_BUILD_RESULTS = new Set(['UNSTABLE', 'FAILURE', 'NOT_BUILT', 'ABORTED']);
// Repository names are fixed by the Dockerfiles and CI; the registry is the only variable part.
const IMAGE_REPOS = Object.freeze({ app: 'agridispatch-vn', function: 'agridispatch-thumbnail' });

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

function hasControlChar(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function parseBaseUrl(raw, { allowLoopbackHttp = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw coded('INVALID_JENKINS_URL', 'JENKINS_URL must be an absolute https URL');
  }
  const httpOk = allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if ((url.protocol !== 'https:' && !httpOk) || url.username || url.password || url.search || url.hash) {
    throw coded('INVALID_JENKINS_URL', 'JENKINS_URL must be https without credentials, query or fragment');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export function jobApiPath(job) {
  if (typeof job !== 'string' || job === '') throw coded('INVALID_JENKINS_JOB', 'JENKINS_JOB must be a job path');
  const segments = job.split('/');
  if (segments.some((segment) => !JOB_SEGMENT.test(segment))) {
    throw coded('INVALID_JENKINS_JOB', 'JENKINS_JOB segments must start with a letter or digit and use only letters, digits, _ . -');
  }
  return segments.map((segment) => `job/${segment}`).join('/');
}

const queueError = () => coded('INVALID_QUEUE_URL', 'Jenkins queue location is not an allowed queue URL');
const buildError = () => coded('INVALID_BUILD_URL', 'Jenkins build location is not an allowed build URL');

export function validateQueueLocation(location, base) {
  let url;
  try {
    url = new URL(location, base);
  } catch {
    throw queueError();
  }
  if (url.origin !== base.origin || url.username || url.password || url.search || url.hash) throw queueError();
  const prefix = `${base.pathname}queue/item/`;
  if (!url.pathname.startsWith(prefix) || !/^\d+\/$/.test(url.pathname.slice(prefix.length))) throw queueError();
  return url;
}

export function validateBuildUrl(location, base, jobPath) {
  let url;
  try {
    url = new URL(location, base);
  } catch {
    throw buildError();
  }
  if (url.origin !== base.origin || url.username || url.password || url.search || url.hash) throw buildError();
  const prefix = `${base.pathname}${jobPath}/`;
  if (!url.pathname.startsWith(prefix) || !/^\d+\/$/.test(url.pathname.slice(prefix.length))) throw buildError();
  return url;
}

function checkSha(sha) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
    throw coded('INVALID_SHA', 'BUILD_SHA must be a full lowercase 40-character SHA');
  }
  return sha;
}

function checkRegistry(registry) {
  if (typeof registry !== 'string' || !REGISTRY_RE.test(registry)) {
    throw coded('INVALID_REGISTRY', 'ACR_REGISTRY must be an Azure Container Registry login server (*.azurecr.io)');
  }
  return registry;
}

function checkManifest(obj, expected) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw coded('INVALID_MANIFEST', 'manifest must be a JSON object');
  }
  const topKeys = new Set(['sha', 'registry', 'published', 'images']);
  if (Object.keys(obj).some((key) => !topKeys.has(key))) {
    throw coded('INVALID_MANIFEST', 'manifest has an unknown key');
  }
  checkSha(obj.sha);
  if (obj.sha !== expected.sha) throw coded('INVALID_MANIFEST', 'manifest sha mismatch');
  checkRegistry(obj.registry);
  if (obj.registry !== expected.registry) throw coded('INVALID_MANIFEST', 'manifest registry mismatch');
  if (typeof obj.published !== 'boolean') throw coded('INVALID_MANIFEST', 'manifest published must be a boolean');
  if (!Array.isArray(obj.images)) throw coded('INVALID_MANIFEST', 'manifest images must be an array');
  if (!obj.published && obj.images.length > 0) throw coded('INVALID_MANIFEST', 'unpublished manifest must list no images');
  const imageKeys = new Set(['name', 'repository', 'tag', 'digest']);
  for (const image of obj.images) {
    if (!image || typeof image !== 'object' || Array.isArray(image)) {
      throw coded('INVALID_MANIFEST', 'manifest image must be an object');
    }
    if (Object.keys(image).some((key) => !imageKeys.has(key))) {
      throw coded('INVALID_MANIFEST', 'manifest image has an unknown key');
    }
    if (!Object.hasOwn(IMAGE_REPOS, image.name)) throw coded('INVALID_MANIFEST', 'manifest image name is not allowed');
    if (image.repository !== IMAGE_REPOS[image.name]) throw coded('INVALID_MANIFEST', 'manifest repository mismatch');
    if (image.tag !== obj.sha) throw coded('INVALID_MANIFEST', 'manifest tag must equal the build SHA');
    if (typeof image.digest !== 'string' || !DIGEST_RE.test(image.digest)) {
      throw coded('INVALID_MANIFEST', 'manifest digest must be sha256 followed by 64 lowercase hex characters');
    }
  }
  const names = obj.images.map((image) => image.name).sort();
  if (new Set(names).size !== names.length) throw coded('INVALID_MANIFEST', 'manifest lists an image twice');
  if (obj.published && names.join(',') !== 'app,function') {
    throw coded('INVALID_MANIFEST', 'published manifest must contain exactly the app and function images');
  }
  return {
    sha: obj.sha,
    registry: obj.registry,
    published: obj.published,
    images: obj.images.map((image) => ({
      name: image.name,
      repository: image.repository,
      tag: image.tag,
      digest: image.digest,
      ref: `${obj.registry}/${image.repository}@${image.digest}`,
    })),
  };
}

export function writeManifest(input) {
  if (!input || typeof input !== 'object') throw coded('INVALID_MANIFEST', 'manifest input must be an object');
  const { sha, registry, published } = input;
  const images = Array.isArray(input.images)
    ? input.images.map((image) => ({
      name: image?.name,
      repository: Object.hasOwn(IMAGE_REPOS, image?.name) ? IMAGE_REPOS[image.name] : undefined,
      tag: sha,
      digest: image?.digest,
    }))
    : input.images;
  const obj = { sha, registry, published, images };
  checkManifest(obj, { sha, registry });
  return `${JSON.stringify(obj, null, 2)}\n`;
}

export function parseManifest(text, expected) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw coded('INVALID_MANIFEST', 'manifest size exceeds the limit');
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw coded('INVALID_MANIFEST', 'manifest is not valid JSON');
  }
  return checkManifest(obj, expected);
}

function parsePublish(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw coded('INVALID_PUBLISH', 'PUBLISH must be true or false');
}

function requireEnv(env, name) {
  const value = env[name];
  if (!value || /\$[({]/.test(value)) {
    throw coded('MISSING_ENV', `${name} is required and must not be an unresolved pipeline macro`);
  }
  return value;
}

export function optionsFromEnv(env = process.env) {
  const timeoutText = env.JENKINS_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number(timeoutText);
  if (!/^\d+$/.test(timeoutText) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw coded('INVALID_TIMEOUT', 'JENKINS_TIMEOUT_MS must be an integer between 60000 and 3600000');
  }
  const allowLoopbackHttp = env.JENKINS_ALLOW_LOOPBACK_HTTP === 'true';
  const job = requireEnv(env, 'JENKINS_JOB');
  jobApiPath(job);
  return {
    base: parseBaseUrl(requireEnv(env, 'JENKINS_URL'), { allowLoopbackHttp }),
    job,
    user: requireEnv(env, 'JENKINS_USER'),
    token: requireEnv(env, 'JENKINS_TOKEN'),
    sha: checkSha(requireEnv(env, 'BUILD_SHA')),
    publish: parsePublish(env.PUBLISH ?? 'false'),
    registry: checkRegistry(requireEnv(env, 'ACR_REGISTRY')),
    timeoutMs,
    pollMs: POLL_MS,
    allowLoopbackHttp,
  };
}

async function readBounded(response, stage = 'response') {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        throw coded('RESPONSE_TOO_LARGE', 'Jenkins response exceeds the size limit');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error?.code === 'RESPONSE_TOO_LARGE') throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw coded('TIMEOUT', `Jenkins ${stage} did not finish within time bound`);
    }
    throw coded('REQUEST_FAILED', 'Jenkins request failed (network, redirect or timeout)');
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), size).toString('utf8');
}

function parseJsonSafe(text, stage) {
  try {
    return JSON.parse(text);
  } catch {
    throw coded('BAD_JSON', `Jenkins ${stage} returned invalid JSON`);
  }
}

export async function runBuild(options) {
  const { base, job, user, token, sha, publish, registry, timeoutMs, pollMs } = options;
  checkSha(sha);
  checkRegistry(registry);
  const jobPath = jobApiPath(job);
  const deadline = Date.now() + timeoutMs;
  const authorization = `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;

  const remaining = (stage) => {
    const left = deadline - Date.now();
    if (left <= 0) throw coded('TIMEOUT', `Jenkins ${stage} did not finish within time bound`);
    return left;
  };

  async function request(stage, url, init = {}) {
    const ms = remaining(stage);
    let response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { ...init.headers, authorization },
        redirect: 'error',
        signal: AbortSignal.timeout(ms),
      });
    } catch {
      if (Date.now() >= deadline) throw coded('TIMEOUT', `Jenkins ${stage} did not finish within time bound`);
      throw coded('REQUEST_FAILED', 'Jenkins request failed (network, redirect or timeout)');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw coded('HTTP_ERROR', `Jenkins request failed with HTTP ${response.status}`);
    }
    return response;
  }

  const crumbResponse = await request('crumb', new URL('crumbIssuer/api/json', base));
  const crumb = parseJsonSafe(await readBounded(crumbResponse, 'crumb'), 'crumb');
  if (
    !crumb || typeof crumb !== 'object' || Array.isArray(crumb)
    || typeof crumb.crumbRequestField !== 'string'
    || !/^[A-Za-z-]{1,64}$/.test(crumb.crumbRequestField)
    || DISALLOWED_CRUMB_FIELDS.has(crumb.crumbRequestField.toLowerCase())
    || typeof crumb.crumb !== 'string'
    || crumb.crumb.length === 0
    || crumb.crumb.length > 512
    || hasControlChar(crumb.crumb)
  ) {
    throw coded('INVALID_CRUMB', 'Jenkins crumb response is invalid');
  }

  const body = new URLSearchParams({ BUILD_SHA: sha, PUBLISH: String(publish) });
  const trigger = await request('trigger', new URL(`${jobPath}/buildWithParameters`, base), {
    method: 'POST',
    headers: { [crumb.crumbRequestField]: crumb.crumb, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  await trigger.body?.cancel().catch(() => {});
  const location = trigger.headers.get('location');
  if (!location) throw coded('MISSING_QUEUE_LOCATION', 'Jenkins did not return a queue location');
  const queueUrl = validateQueueLocation(location, base);

  let buildUrl;
  let buildNumber;
  for (;;) {
    const queue = parseJsonSafe(await readBounded(await request('queue', new URL('api/json', queueUrl)), 'queue'), 'queue');
    if (!queue || typeof queue !== 'object' || Array.isArray(queue)) {
      throw coded('BAD_JSON', 'Jenkins queue response is invalid');
    }
    if (queue.cancelled) throw coded('QUEUE_CANCELLED', 'Jenkins queue item was cancelled');
    if (queue.executable) {
      const executableNumber = queue.executable.number;
      if (!Number.isSafeInteger(executableNumber) || executableNumber <= 0) {
        throw coded('INVALID_BUILD_NUMBER', 'Jenkins build number is invalid');
      }
      buildUrl = validateBuildUrl(queue.executable.url, base, jobPath);
      const urlBuildId = Number(buildUrl.pathname.slice(`${base.pathname}${jobPath}/`.length, -1));
      if (urlBuildId !== executableNumber) {
        throw coded('BUILD_NUMBER_MISMATCH', 'Jenkins build URL does not match build number');
      }
      buildNumber = executableNumber;
      break;
    }
    await sleep(Math.min(pollMs, remaining('queue')));
  }

  for (;;) {
    const build = parseJsonSafe(
      await readBounded(await request('build', new URL('api/json?tree=building,result,number', buildUrl)), 'build'),
      'build',
    );
    if (!build || typeof build !== 'object' || Array.isArray(build) || build.number !== buildNumber) {
      throw coded('BUILD_NUMBER_MISMATCH', 'Jenkins build status number mismatch');
    }
    if (!build.building && typeof build.result === 'string') {
      if (build.result !== 'SUCCESS') {
        const safeResult = ALLOWED_BUILD_RESULTS.has(build.result) ? build.result : 'UNKNOWN';
        throw coded('BUILD_FAILED', `Jenkins build finished with ${safeResult}`);
      }
      break;
    }
    await sleep(Math.min(pollMs, remaining('build')));
  }

  const manifestResponse = await request('artifact', new URL('artifact/build-manifest.json', buildUrl));
  const manifest = parseManifest(await readBounded(manifestResponse, 'artifact'), { sha, registry });
  if (manifest.published !== publish) throw coded('PUBLISH_MISMATCH', 'manifest publish flag does not match the request');
  return { status: 'SUCCESS', buildNumber, sha, publish, images: manifest.images };
}

function manifestFromEnv(env) {
  const publish = parsePublish(env.PUBLISH ?? 'false');
  const images = publish
    ? [{ name: 'app', digest: env.APP_DIGEST }, { name: 'function', digest: env.FUNCTION_DIGEST }]
    : [];
  return writeManifest({ sha: checkSha(env.BUILD_SHA), registry: checkRegistry(env.ACR_REGISTRY), published: publish, images });
}

export async function main(argv, env = process.env, out = process.stdout, err = process.stderr) {
  const [command, target] = argv;
  try {
    if (command === 'run') {
      const result = await runBuild(optionsFromEnv(env));
      out.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (command === 'write-manifest' && target) {
      const manifestText = manifestFromEnv(env);
      try {
        await writeFile(resolve(target), manifestText, { flag: 'wx' });
      } catch {
        throw coded('MANIFEST_WRITE_FAILED', 'Failed to write build manifest');
      }
      return 0;
    }
  } catch (error) {
    err.write(`jenkins-build: ${error?.code ?? 'INTERNAL_ERROR'}\n`);
    return 1;
  }
  err.write('usage: jenkins-build.js run | write-manifest <out.json>\n');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), process.env, process.stdout, process.stderr);
}
