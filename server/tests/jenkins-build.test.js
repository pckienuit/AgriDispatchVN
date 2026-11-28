import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { validateRelease } from '../scripts/cloud/preflight.js';
import {
  parseBaseUrl,
  jobApiPath,
  validateQueueLocation,
  validateBuildUrl,
  parseManifest,
  writeManifest,
  runBuild,
  optionsFromEnv,
  main,
} from '../scripts/jenkins-build.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const REGISTRY = 'agridispatchacr.azurecr.io';
const DIGEST_A = `sha256:${'1'.repeat(64)}`;
const DIGEST_F = `sha256:${'2'.repeat(64)}`;
const TOKEN = 'tok_SECRET_VALUE_123456';

const manifestInput = (over = {}) => ({
  sha: SHA, registry: REGISTRY, published: true,
  images: [
    { name: 'app', digest: DIGEST_A },
    { name: 'function', digest: DIGEST_F },
  ],
  ...over,
});

test('Jenkins base URL must be https, without credentials, query or fragment', () => {
  assert.equal(parseBaseUrl('https://jenkins.example.org/jenkins').href, 'https://jenkins.example.org/jenkins/');
  for (const raw of ['http://jenkins.example.org/', 'https://u:p@jenkins.example.org/', 'https://j.example.org/?x=1', 'https://j.example.org/#f', 'ftp://j.example.org/', 'not a url']) {
    assert.throws(() => parseBaseUrl(raw), /JENKINS_URL/, raw);
  }
});

test('plain HTTP is accepted only for explicit loopback test option', () => {
  assert.equal(parseBaseUrl('http://127.0.0.1:8080/', { allowLoopbackHttp: true }).port, '8080');
  assert.throws(() => parseBaseUrl('http://127.0.0.1:8080/'), /JENKINS_URL/);
  assert.throws(() => parseBaseUrl('http://10.0.0.5:8080/', { allowLoopbackHttp: true }), /JENKINS_URL/);
});

test('job path keeps each user-supplied segment literal and rejects unsafe segments', () => {
  assert.equal(jobApiPath('agridispatch/cloud_Build-1.0'), 'job/agridispatch/job/cloud_Build-1.0');
  for (const job of ['', '../x', 'a b', 'a?x=1', 'a%2Fb', 'a//b', '/a', 'a/', '-leading']) {
    assert.throws(() => jobApiPath(job), /JENKINS_JOB/, job);
  }
});

test('queue location must stay on the Jenkins origin and under queue/item', () => {
  const base = parseBaseUrl('https://jenkins.example.org/jenkins/');
  assert.equal(validateQueueLocation('https://jenkins.example.org/jenkins/queue/item/42/', base).pathname, '/jenkins/queue/item/42/');
  for (const loc of [
    'https://evil.example.net/jenkins/queue/item/42/',
    'https://jenkins.example.org/other/queue/item/42/',
    'https://jenkins.example.org/jenkins/queue/item/x/',
    'https://jenkins.example.org/jenkins/queue/item/42/../../x',
    'https://u:p@jenkins.example.org/jenkins/queue/item/42/',
    'https://jenkins.example.org/jenkins/queue/item/42/?q=1',
    'https://jenkins.example.org/jenkins/queue/item/42/#f',
  ]) {
    assert.throws(() => validateQueueLocation(loc, base), /queue/i, loc);
  }
});

test('build URL must stay on origin, match job path, forbid credentials/query/hash and have numeric build ID only', () => {
  const base = parseBaseUrl('https://jenkins.example.org/jenkins/');
  const jobPath = jobApiPath('agridispatch/cloud');
  assert.equal(
    validateBuildUrl('https://jenkins.example.org/jenkins/job/agridispatch/job/cloud/17/', base, jobPath).pathname,
    '/jenkins/job/agridispatch/job/cloud/17/',
  );
  for (const loc of [
    'https://evil.example.net/jenkins/job/agridispatch/job/cloud/17/',
    'https://u:p@jenkins.example.org/jenkins/job/agridispatch/job/cloud/17/',
    'https://jenkins.example.org/jenkins/job/agridispatch/job/cloud/17/?x=1',
    'https://jenkins.example.org/jenkins/job/agridispatch/job/cloud/17/#hash',
    'https://jenkins.example.org/jenkins/job/agridispatch/job/cloud/17',
    'https://jenkins.example.org/jenkins/job/agridispatch/job/cloud/abc/',
    'https://jenkins.example.org/jenkins/job/agridispatch/job/cloud/17/ws/',
    'https://jenkins.example.org/jenkins/job/agridispatch/job/other/17/',
    'https://jenkins.example.org/jenkins/job/agridispatch/job/cloud/17/../../other/1/',
  ]) {
    assert.throws(() => validateBuildUrl(loc, base, jobPath), /build location/i, loc);
  }
});

test('manifest accepts exact SHA, configured registry and digest-pinned images', () => {
  const parsed = parseManifest(writeManifest(manifestInput()), { sha: SHA, registry: REGISTRY });
  assert.equal(parsed.published, true);
  assert.deepEqual(parsed.images.map((i) => i.name).sort(), ['app', 'function']);
  assert.equal(parsed.images.find((i) => i.name === 'app').ref, `${REGISTRY}/agridispatch-vn@${DIGEST_A}`);
  assert.equal(parsed.images.find((i) => i.name === 'app').tag, SHA);
});

test('manifest rejects wrong SHA, registry, mutable tag, bad digest and extra keys', () => {
  const ok = (over) => writeManifest(manifestInput(over));
  assert.throws(() => parseManifest(ok({ sha: OTHER }), { sha: SHA, registry: REGISTRY }), /sha/);
  assert.throws(() => parseManifest(ok({ registry: 'otherregistry.azurecr.io' }), { sha: SHA, registry: REGISTRY }), /registry/);
  const badTag = JSON.parse(ok());
  badTag.images[0].tag = 'latest';
  assert.throws(() => parseManifest(JSON.stringify(badTag), { sha: SHA, registry: REGISTRY }), /tag/);
  assert.throws(() => writeManifest(manifestInput({ images: [{ name: 'app', digest: 'sha256:short' }, { name: 'function', digest: DIGEST_F }] })), /digest/);
  const extra = JSON.parse(ok());
  extra.extra = true;
  assert.throws(() => parseManifest(JSON.stringify(extra), { sha: SHA, registry: REGISTRY }), /unknown/);
  assert.throws(() => parseManifest('x'.repeat(70000), { sha: SHA, registry: REGISTRY }), /size/);
});

test('unpublished manifest carries no images and no digests', () => {
  const parsed = parseManifest(writeManifest({ sha: SHA, registry: REGISTRY, published: false, images: [] }), { sha: SHA, registry: REGISTRY });
  assert.deepEqual(parsed.images, []);
  assert.throws(() => writeManifest({ sha: SHA, registry: REGISTRY, published: false, images: [{ name: 'app', digest: DIGEST_A }] }), /published/);
});

// Fake Jenkins: loopback HTTP, test-only option. Records every request for assertions.
function fakeJenkins(handler, { autoCrumb = true } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (autoCrumb && req.url === '/jenkins/crumbIssuer/api/json') {
        return json(res, 200, { crumbRequestField: 'Jenkins-Crumb', crumb: 'crumb-1' });
      }
      handler(req, res, body, seen);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const close = () => {
      server.closeAllConnections();
      server.close();
    };
    resolve({ server, close, seen, base: `http://127.0.0.1:${port}/jenkins/` });
  }));
}
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

function happyHandler(manifestText) {
  return (req, res) => {
    const origin = `http://${req.headers.host}`;
    if (req.url === '/jenkins/job/agridispatch/job/cloud/buildWithParameters' && req.method === 'POST') {
      res.writeHead(201, { location: `${origin}/jenkins/queue/item/7/` });
      return res.end();
    }
    if (req.url === '/jenkins/queue/item/7/api/json') return json(res, 200, { executable: { number: 3, url: `${origin}/jenkins/job/agridispatch/job/cloud/3/` } });
    if (req.url.startsWith('/jenkins/job/agridispatch/job/cloud/3/api/json')) return json(res, 200, { building: false, result: 'SUCCESS', number: 3 });
    if (req.url === '/jenkins/job/agridispatch/job/cloud/3/artifact/build-manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(manifestText);
    }
    json(res, 404, {});
  };
}

const runOpts = (base, over = {}) => ({
  base: parseBaseUrl(base, { allowLoopbackHttp: true }), job: 'agridispatch/cloud', user: 'ci-bot', token: TOKEN,
  sha: SHA, publish: true, registry: REGISTRY, timeoutMs: 5000, pollMs: 10, ...over,
});

test('successful build triggers with crumb, verifies manifest and returns digest refs', async () => {
  const fake = await fakeJenkins(happyHandler(writeManifest(manifestInput())));
  try {
    const result = await runBuild(runOpts(fake.base));
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.buildNumber, 3);
    assert.equal(result.images.length, 2);
    const post = fake.seen.find((r) => r.method === 'POST');
    assert.equal(post.url, '/jenkins/job/agridispatch/job/cloud/buildWithParameters');
    assert.equal(post.headers['jenkins-crumb'], 'crumb-1');
    assert.match(post.body, new RegExp(`BUILD_SHA=${SHA}`));
    assert.match(post.body, /PUBLISH=true/);
    assert.equal(fake.seen.filter((r) => r.method === 'POST').length, 1);
    assert.equal(fake.seen.filter((r) => r.method === 'GET' && r.url.includes('crumbIssuer')).length, 1);
  } finally { fake.close(); }
});

test('Jenkins HTTP artifact feeds the real release input gate without adapting its envelope', async () => {
  const fake = await fakeJenkins(happyHandler(writeManifest(manifestInput())));
  try {
    const result = await runBuild(runOpts(fake.base));
    const uuid = '11111111-1111-1111-1111-111111111111';
    const checkedAt = new Date().toISOString();
    const target = {
      subscription: uuid, resourceGroup: 'rg-agridispatch-bt05', app: 'app-synthetic',
      stagingProbeUrl: 'https://app-synthetic-staging.azurewebsites.net', productionProbeUrl: 'https://app-synthetic.azurewebsites.net',
      clusterResourceId: `/subscriptions/${uuid}/resourceGroups/rg-agridispatch-bt05/providers/Microsoft.ContainerService/managedClusters/aks-synthetic`,
      context: 'aks-synthetic', kubeconfig: '/outside/repo/kubeconfig', clientId: uuid,
      migrationClientId: '22222222-2222-2222-2222-222222222222', tenantId: uuid, keyVaultName: 'kv-synthetic',
      functionApp: 'func-synthetic', functionProbeUrl: 'https://func-synthetic.azurewebsites.net',
      approval: { id: 'synthetic-approval', checkedAt, quotaVerified: true, costComplete: true, spendingLimitOn: true, capUsd: 43.03, remainingCreditUsd: 86.06, estimatedTotalUsd: 35 },
    };
    const approved = validateRelease(result, target, { sha: SHA, budgetApproval: target.approval.id, quotaCheckedAt: checkedAt });
    assert.equal(approved.images.app, `${REGISTRY}/agridispatch-vn@${DIGEST_A}`);
    assert.equal(approved.images.function, `${REGISTRY}/agridispatch-thumbnail@${DIGEST_F}`);
    assert.throws(() => validateRelease({ ...result, sha: OTHER }, target, { sha: SHA, budgetApproval: target.approval.id, quotaCheckedAt: checkedAt }));
  } finally { fake.close(); }
});

test('build FAILURE and cancelled queue item fail; errors never echo token, URL or untrusted result string', async () => {
  const failing = await fakeJenkins((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (req.method === 'POST') { res.writeHead(201, { location: `${origin}/jenkins/queue/item/8/` }); return res.end(); }
    if (req.url.endsWith('queue/item/8/api/json')) return json(res, 200, { executable: { number: 4, url: `${origin}/jenkins/job/agridispatch/job/cloud/4/` } });
    return json(res, 200, { building: false, result: 'FAILURE', number: 4 });
  });
  try {
    await assert.rejects(runBuild(runOpts(failing.base)), (e) => /FAILURE/.test(e.message) && !e.message.includes(TOKEN) && !e.message.includes('127.0.0.1'));
  } finally { failing.close(); }

  const hostileResult = await fakeJenkins((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (req.method === 'POST') { res.writeHead(201, { location: `${origin}/jenkins/queue/item/8/` }); return res.end(); }
    if (req.url.endsWith('queue/item/8/api/json')) return json(res, 200, { executable: { number: 4, url: `${origin}/jenkins/job/agridispatch/job/cloud/4/` } });
    return json(res, 200, { building: false, result: `EVIL_EXFIL_${TOKEN}`, number: 4 });
  });
  try {
    await assert.rejects(runBuild(runOpts(hostileResult.base)), (e) => /UNKNOWN/.test(e.message) && !e.message.includes('EVIL_EXFIL') && !e.message.includes(TOKEN));
  } finally { hostileResult.close(); }

  const cancelled = await fakeJenkins((req, res) => {
    if (req.method === 'POST') { res.writeHead(201, { location: `http://${req.headers.host}/jenkins/queue/item/9/` }); return res.end(); }
    return json(res, 200, { cancelled: true, why: 'user cancelled' });
  });
  try {
    await assert.rejects(runBuild(runOpts(cancelled.base)), /cancel/i);
  } finally { cancelled.close(); }
});

test('pending queue item stops at the time bound', async () => {
  const pending = await fakeJenkins((req, res) => {
    if (req.method === 'POST') { res.writeHead(201, { location: `http://${req.headers.host}/jenkins/queue/item/10/` }); return res.end(); }
    return json(res, 200, { why: 'waiting for executor' });
  });
  try {
    const started = Date.now();
    await assert.rejects(runBuild(runOpts(pending.base, { timeoutMs: 400 })), /time bound/);
    assert.ok(Date.now() - started < 3000, 'bounded wait must end near timeoutMs');
  } finally { pending.close(); }
});

test('real HTTP stub rejects streaming chunked body over 64 KiB without buffering whole response', async () => {
  let bytesSent = 0;
  const oversize = await fakeJenkins((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (req.method === 'POST') { res.writeHead(201, { location: `${origin}/jenkins/queue/item/11/` }); return res.end(); }
    if (req.url.endsWith('queue/item/11/api/json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      for (let i = 0; i < 32; i += 1) {
        if (res.destroyed) break;
        const chunk = 'x'.repeat(8192);
        bytesSent += chunk.length;
        res.write(chunk);
      }
      return res.end();
    }
    json(res, 404, {});
  });
  try {
    await assert.rejects(runBuild(runOpts(oversize.base)), /size limit/);
    assert.ok(bytesSent <= 256 * 1024);
  } finally { oversize.close(); }
});

test('real HTTP stub aborts hanging response body after headers at deadline', async () => {
  const hanging = await fakeJenkins((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (req.method === 'POST') { res.writeHead(201, { location: `${origin}/jenkins/queue/item/12/` }); return res.end(); }
    if (req.url.endsWith('queue/item/12/api/json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"executable":');
      return;
    }
    json(res, 404, {});
  });
  try {
    const started = Date.now();
    await assert.rejects(runBuild(runOpts(hanging.base, { timeoutMs: 250 })), /time bound/);
    assert.ok(Date.now() - started < 2000, 'hanging body must abort near timeoutMs');
  } finally { hanging.close(); }
});

test('redirects, off-origin queue/build URLs and build number mismatches fail before follow-up requests', async () => {
  const redirect = await fakeJenkins((req, res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });
  try {
    await assert.rejects(runBuild(runOpts(redirect.base)), /Jenkins request failed/);
    assert.equal(redirect.seen.some((r) => r.url.includes('meta-data')), false);
  } finally { redirect.close(); }

  const offOriginQueue = await fakeJenkins((req, res) => {
    res.writeHead(201, { location: 'https://evil.example.net/jenkins/queue/item/1/' });
    res.end();
  });
  try {
    await assert.rejects(runBuild(runOpts(offOriginQueue.base)), /queue/i);
    assert.equal(offOriginQueue.seen.filter((r) => r.method === 'GET').length, 1);
  } finally { offOriginQueue.close(); }

  const badBuildUrl = await fakeJenkins((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (req.method === 'POST') { res.writeHead(201, { location: `${origin}/jenkins/queue/item/13/` }); return res.end(); }
    if (req.url.endsWith('queue/item/13/api/json')) {
      return json(res, 200, { executable: { number: 5, url: `${origin}/jenkins/job/agridispatch/job/other/5/` } });
    }
    json(res, 404, {});
  });
  try {
    await assert.rejects(runBuild(runOpts(badBuildUrl.base)), /build location/i);
    assert.equal(badBuildUrl.seen.some((r) => r.url.includes('/job/other/')), false);
  } finally { badBuildUrl.close(); }

  const urlNumberMismatch = await fakeJenkins((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (req.method === 'POST') { res.writeHead(201, { location: `${origin}/jenkins/queue/item/14/` }); return res.end(); }
    if (req.url.endsWith('queue/item/14/api/json')) {
      return json(res, 200, { executable: { number: 99, url: `${origin}/jenkins/job/agridispatch/job/cloud/5/` } });
    }
    json(res, 404, {});
  });
  try {
    await assert.rejects(runBuild(runOpts(urlNumberMismatch.base)), /build number/i);
    assert.equal(urlNumberMismatch.seen.some((r) => r.url.includes('/cloud/5/')), false);
  } finally { urlNumberMismatch.close(); }

  const statusNumberMismatch = await fakeJenkins((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (req.method === 'POST') { res.writeHead(201, { location: `${origin}/jenkins/queue/item/15/` }); return res.end(); }
    if (req.url.endsWith('queue/item/15/api/json')) {
      return json(res, 200, { executable: { number: 5, url: `${origin}/jenkins/job/agridispatch/job/cloud/5/` } });
    }
    if (req.url.startsWith('/jenkins/job/agridispatch/job/cloud/5/api/json')) {
      return json(res, 200, { building: false, result: 'SUCCESS', number: 6 });
    }
    json(res, 404, {});
  });
  try {
    await assert.rejects(runBuild(runOpts(statusNumberMismatch.base)), /mismatch/i);
    assert.equal(statusNumberMismatch.seen.some((r) => r.url.includes('artifact/build-manifest.json')), false);
  } finally { statusNumberMismatch.close(); }
});

test('crumb issuer rejects header overrides and CRLF injection before POST', async () => {
  for (const badCrumb of [
    { crumbRequestField: 'Authorization', crumb: 'Basic evil' },
    { crumbRequestField: 'content-type', crumb: 'text/plain' },
    { crumbRequestField: 'Host', crumb: 'evil.example.net' },
    { crumbRequestField: 'Jenkins-Crumb', crumb: 'abc\r\nX-Injected: 1' },
    { crumbRequestField: 'Jenkins-Crumb', crumb: 'abc\n' },
  ]) {
    const fake = await fakeJenkins((req, res) => {
      if (req.url === '/jenkins/crumbIssuer/api/json') return json(res, 200, badCrumb);
      json(res, 500, {});
    }, { autoCrumb: false });
    try {
      await assert.rejects(runBuild(runOpts(fake.base)), /crumb/i);
      assert.equal(fake.seen.some((r) => r.method === 'POST'), false);
    } finally { fake.close(); }
  }
});

test('published build with a manifest for another SHA fails closed', async () => {
  const fake = await fakeJenkins(happyHandler(writeManifest(manifestInput({ sha: OTHER }))));
  try {
    await assert.rejects(runBuild(runOpts(fake.base)), /sha/);
  } finally { fake.close(); }
});

test('optionsFromEnv fails closed on missing, unresolved Azure macro or bad PUBLISH without echoing secrets', () => {
  const env = {
    JENKINS_URL: 'https://jenkins.example.org/jenkins', JENKINS_JOB: 'agridispatch/cloud', JENKINS_USER: 'ci-bot',
    JENKINS_TOKEN: TOKEN, BUILD_SHA: SHA, PUBLISH: 'false', ACR_REGISTRY: REGISTRY,
  };
  const ok = optionsFromEnv(env);
  assert.equal(ok.publish, false);
  assert.equal(ok.allowLoopbackHttp, false);
  assert.throws(() => optionsFromEnv({ ...env, JENKINS_TOKEN: undefined }), /JENKINS_TOKEN/);
  assert.throws(() => optionsFromEnv({ ...env, JENKINS_TOKEN: '$(JENKINS_TOKEN)' }), (e) => /JENKINS_TOKEN/.test(e.message) && !e.message.includes('$('));
  assert.throws(() => optionsFromEnv({ ...env, PUBLISH: 'yes' }), /PUBLISH/);
  assert.throws(() => optionsFromEnv({ ...env, ACR_REGISTRY: 'evil.example.net' }), /ACR_REGISTRY/);
  assert.throws(() => optionsFromEnv({ ...env, BUILD_SHA: 'main' }), /BUILD_SHA/);
  assert.throws(() => optionsFromEnv({ ...env, JENKINS_URL: 'http://jenkins.example.org/' }), (e) => /JENKINS_URL/.test(e.message) && !e.message.includes('example.org'));
});

test('CLI main prints fixed safe error codes and never echoes secrets, URLs or invalid JSON bodies', async () => {
  const fake = await fakeJenkins((req, res) => {
    if (req.url === '/jenkins/crumbIssuer/api/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(`NOT_JSON_${TOKEN}`);
    }
    json(res, 404, {});
  }, { autoCrumb: false });
  try {
    let out = '';
    let err = '';
    const code = await main(
      ['run'],
      {
        JENKINS_URL: fake.base,
        JENKINS_ALLOW_LOOPBACK_HTTP: 'true',
        JENKINS_JOB: 'agridispatch/cloud',
        JENKINS_USER: 'ci-bot',
        JENKINS_TOKEN: TOKEN,
        BUILD_SHA: SHA,
        PUBLISH: 'false',
        ACR_REGISTRY: REGISTRY,
      },
      { write: (s) => { out += s; } },
      { write: (s) => { err += s; } },
    );
    assert.equal(code, 1);
    assert.equal(out, '');
    assert.equal(err, 'jenkins-build: BAD_JSON\n');
    assert.equal(err.includes(TOKEN), false);
    assert.equal(err.includes('127.0.0.1'), false);
  } finally { fake.close(); }
});

// Structural checks for the pipeline definitions. Root files are mandatory; never skip if missing.
// Test hosts provide Python + PyYAML. Runtime REST client remains Node stdlib only.
const jenkinsfile = readFileSync(new URL('../../Jenkinsfile', import.meta.url), 'utf8');
const azureText = readFileSync(new URL('../../azure-pipelines.yml', import.meta.url), 'utf8');
const docs = readFileSync(new URL('../../docs/pipelines.md', import.meta.url), 'utf8');

function loadAzure() {
  const result = execFileSync('python3', ['-c',
    'import sys,yaml,json;print(json.dumps(yaml.safe_load(open(sys.argv[1],encoding="utf-8"))))',
    fileURLToPath(new URL('../../azure-pipelines.yml', import.meta.url))], { encoding: 'utf8' });
  return JSON.parse(result);
}

const shBlocks = (text) => [...text.matchAll(/'''([\s\S]*?)'''/g)].map((m) => m[1]);

test('Jenkinsfile declares literal BUILD_SHA (no trim: true) and PUBLISH=false parameters', () => {
  assert.match(jenkinsfile, /string\(name: 'BUILD_SHA',\s*trim: false/);
  assert.doesNotMatch(jenkinsfile, /string\(name: 'BUILD_SHA'[^)]*trim:\s*true/);
  assert.match(jenkinsfile, /booleanParam\(name: 'PUBLISH', defaultValue: false/);
  assert.match(jenkinsfile, /params\.BUILD_SHA ==~ \/\[0-9a-f\]\{40\}\//);
  assert.match(jenkinsfile, /APPROVED_BRANCH = 'cloud\/is402-2026-11-24'/);
  assert.match(jenkinsfile, /if \[ "\$head" != "\$BUILD_SHA" \]/);
  assert.match(jenkinsfile, /skipDefaultCheckout\(true\)/);
});

test('Jenkinsfile never interpolates request parameters inside shell bodies and keeps ephemeral files outside workspace', () => {
  assert.equal(shBlocks(jenkinsfile).length, 9);
  for (const block of shBlocks(jenkinsfile)) {
    assert.doesNotMatch(block, /\$\{params\./, 'shell body must read BUILD_SHA from env, not Groovy params');
    assert.match(block, /^\s*set \+x\s*\n/, 'Jenkins shell tracing must be disabled before generated credentials');
  }
  assert.doesNotMatch(jenkinsfile, /\.ci-ephemeral/);
  assert.match(jenkinsfile, /env\.CI_EPH = sh\(returnStdout: true, script: 'umask 077 && mktemp -d'\)/);
  assert.match(jenkinsfile, /printf 'POSTGRES_PASSWORD=%s\\nINTERNAL_SERVICE_TOKEN=%s\\n'/);
  assert.doesNotMatch(jenkinsfile, /POSTGRES_PASSWORD=%s\\\\n/);
});

test('Jenkinsfile publishes only behind PUBLISH gate, isolates DOCKER_CONFIG, verifies subscription/RG/ACR id and passes BUILD_SHA to Function build', () => {
  assert.match(jenkinsfile, /stage\('Publish to ACR'\) \{\s*when \{ expression \{ params\.PUBLISH \} \}/);
  assert.match(jenkinsfile, /RESOURCE_GROUP = 'rg-agridispatch-bt05'/);
  assert.match(jenkinsfile, /export DOCKER_CONFIG="\$CI_EPH\/docker-config"/);
  assert.match(jenkinsfile, /DOCKER_CONFIG="\$CI_EPH\/docker-config" docker logout "\$ACR_REGISTRY"/);
  assert.doesNotMatch(jenkinsfile, /^[ \t]*docker logout/m);
  assert.match(jenkinsfile, /az acr show --subscription "\$AZURE_SUBSCRIPTION_ID" --resource-group "\$RESOURCE_GROUP" --name "\$ACR_NAME" --query id/);
  assert.match(jenkinsfile, /docker build -f infra\/Function\.Dockerfile --build-arg BUILD_SHA="\$BUILD_SHA"/);
  assert.doesNotMatch(jenkinsfile, /:latest\b/);
  assert.doesNotMatch(jenkinsfile, /docker login/);
  assert.doesNotMatch(jenkinsfile, /--password/);
  assert.match(jenkinsfile, /az acr repository show/);
});

test('Jenkinsfile archives the manifest and tears down its own Compose project, images and external temp dir', () => {
  assert.match(jenkinsfile, /archiveArtifacts artifacts: 'build-manifest\.json'/);
  assert.match(jenkinsfile, /down -v --remove-orphans/);
  assert.match(jenkinsfile, /-f "\$OVERRIDE"/);
  assert.match(jenkinsfile, /ports: !reset \[\]/);
  assert.match(jenkinsfile, /network_mode: service:test-db/);
  assert.match(jenkinsfile, /TEST_DATABASE_URL:\s*postgresql:\/\/agridispatch:disposable_test_only@127\.0\.0\.1:5432\/agridispatch_test/);
  assert.doesNotMatch(jenkinsfile, /\*\*\*/);
  assert.match(jenkinsfile, /rm -rf "\$CI_EPH"/);
  assert.doesNotMatch(jenkinsfile, /echo\s+['"]?Success/);
});

test('disposable Compose PostgreSQL requires SCRAM on local and host connections', () => {
  const compose = execFileSync('python3', ['-c', 'import json,yaml,sys;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', fileURLToPath(new URL('../../infra/compose.yaml', import.meta.url))], { encoding: 'utf8' });
  const init = JSON.parse(compose).services['test-db'].environment.POSTGRES_INITDB_ARGS;
  assert.equal(init, '--auth-host=scram-sha-256 --auth-local=scram-sha-256');
});

test('Azure pipeline parses and triggers only on the approved branch with fixed infra/terraform and Validate+Terraform before Build', () => {
  const az = loadAzure();
  assert.deepEqual(az.trigger.branches.include, ['cloud/is402-2026-11-24']);
  assert.deepEqual(az.pr.branches.include, ['cloud/is402-2026-11-24']);
  assert.deepEqual(az.stages.map((s) => s.stage), ['Validate', 'Terraform', 'Build', 'Deploy']);
  assert.equal(az.parameters.some((p) => p.name === 'terraformDir'), false);
  assert.equal(az.variables.TERRAFORM_VERSION, '1.17.2');
  assert.equal(az.variables.TERRAFORM_DIR, 'infra/terraform');
  const tf = az.stages.find((s) => s.stage === 'Terraform');
  assert.equal(tf.jobs[0].pool.name, 'agridispatch-jenkins-bridge');
  assert.equal(JSON.stringify(tf).includes('TerraformInstaller'), false);
  const tfBash = tf.jobs[0].steps.find((x) => x.bash)?.bash ?? '';
  assert.match(tfBash, /fmt -check -recursive/);
  assert.match(tfBash, /init -backend=false -input=false/);
  assert.match(tfBash, /terraform -chdir="\$TF_DIR" validate/);
  assert.match(tfBash, /terraform -chdir="\$TF_DIR" test -no-color/);
  const build = az.stages.find((s) => s.stage === 'Build');
  assert.deepEqual(build.dependsOn, ['Validate', 'Terraform']);
});

test('Azure PR and Validate paths carry no secret group, no self-hosted pool and do not call Jenkins', () => {
  const az = loadAzure();
  const validate = az.stages.find((s) => s.stage === 'Validate');
  assert.equal(validate.jobs[0].pool.vmImage, 'ubuntu-24.04');
  assert.equal(JSON.stringify(validate).includes('agridispatch-jenkins-bridge'), false);
  assert.equal(JSON.stringify(validate).includes('agridispatch-cloud-ci'), false);
  assert.equal(JSON.stringify(validate).includes('JENKINS_TOKEN'), false);
  for (const stageName of ['Terraform', 'Build', 'Deploy']) {
    const stage = az.stages.find((s) => s.stage === stageName);
    assert.match(stage.condition, /ne\(variables\['Build\.Reason'\],\s*'PullRequest'\)/, stageName);
    assert.match(stage.condition, /eq\(variables\['Build\.SourceBranch'\],\s*'refs\/heads\/cloud\/is402-2026-11-24'\)/, stageName);
  }
  const validation = validate.jobs[0].steps.find(step => step.bash)?.bash ?? '';
  assert.match(validation, /pip install PyYAML==6\.0\.3/);
});

test('Azure Build stage uses the wrapper with secret variables mapped and no inline secret', () => {
  const az = loadAzure();
  const build = az.stages.find((s) => s.stage === 'Build');
  assert.deepEqual(build.variables, [{ group: 'agridispatch-cloud-ci' }]);
  const step = build.jobs[0].steps.find((x) => x.displayName?.startsWith('Trigger Jenkins'));
  assert.equal(step.env.JENKINS_TOKEN, '$(JENKINS_TOKEN)');
  assert.match(step.bash, /node server\/scripts\/jenkins-build\.js run/);
  assert.match(step.bash, /\^\[0-9a-f\]\{40\}\$/);
});

test('Azure Deploy uses compile-time ${{ }} parameter conditions and wires TARGET_CONFIG_FILE plus wrapper flags', () => {
  const az = loadAzure();
  const deploy = az.stages.find((s) => s.stage === 'Deploy');
  assert.match(deploy.condition, /\$\{\{\s*eq\(parameters\.cloudReady, true\)\s*\}\}/);
  assert.match(deploy.condition, /\$\{\{\s*eq\(parameters\.publish, true\)\s*\}\}/);
  assert.doesNotMatch(azureText, /condition:.*(?<!\$\{\{[^}]*)\bparameters\./);
  assert.equal(deploy.jobs[0].environment, 'agridispatch-is402-cloud');
  const cloudReady = az.parameters.find((p) => p.name === 'cloudReady');
  const publish = az.parameters.find((p) => p.name === 'publish');
  assert.equal(cloudReady.default, false);
  assert.equal(cloudReady.type, 'boolean');
  assert.equal(publish.default, false);
  assert.equal(publish.type, 'boolean');
  const step = deploy.jobs[0].strategy.runOnce.deploy.steps.find((x) => x.bash);
  assert.equal(step.env.TARGET_CONFIG_FILE, '$(TARGET_CONFIG_FILE)');
  assert.match(step.bash, /preflight\.js --result "\$RESULT_FILE" --sha "\$BUILD_SHA" --budget-approval "\$BUDGET_APPROVAL_ID" --quota-checked-at "\$QUOTA_CHECKED_AT" --target "\$TARGET_CONFIG_FILE"/);
  assert.match(step.bash, /deploy\.js --result "\$RESULT_FILE" --sha "\$BUILD_SHA" --target "\$TARGET_CONFIG_FILE" --budget-approval "\$BUDGET_APPROVAL_ID" --quota-checked-at "\$QUOTA_CHECKED_AT" --execute/);
  assert.match(step.bash, /verify\.js --result "\$RESULT_FILE" --sha "\$BUILD_SHA" --target "\$TARGET_CONFIG_FILE" --budget-approval "\$BUDGET_APPROVAL_ID" --quota-checked-at "\$QUOTA_CHECKED_AT"/);
  assert.match(step.bash, /86_400_000/);
});

test('Azure file contains no literal secrets, mutable tags or unresolved pipeline placeholders', () => {
  assert.doesNotMatch(azureText, /:latest\b/);
  assert.doesNotMatch(azureText, /password\s*[:=]\s*['"]?[A-Za-z0-9]{6,}/i);
  assert.doesNotMatch(azureText, /\bsecretValue\b/i);
});

test('runbook records real Jenkins and Azure scope, cost, separate YAML gate and remaining blockers', () => {
  for (const term of [
    'Jenkins',
    'Azure DevOps',
    'ACR',
    'AKS',
    'Azure Monitor',
    'Azure Web Apps',
    'Terraform',
    '1.17.2',
    'Key Vault',
    'GitHub Actions',
    'VPN',
    'cloudReady',
    'localhost',
    'TARGET_CONFIG_FILE',
    'DOCKER_CONFIG',
    'yaml.safe_load',
    'infra/Dockerfile',
  ]) {
    assert.match(docs, new RegExp(term.replace('.', '\\.')), term);
  }
  assert.match(docs, /Chi phí/i);
});
