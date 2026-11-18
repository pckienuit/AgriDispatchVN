import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/export-release.js', import.meta.url));
const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: tmpdir(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const BASE_FILES = {
  'package.json': '{"name":"fixture","private":true}\n',
  'package-lock.json': '{"lockfileVersion":3}\n',
  '.nvmrc': '26\n',
  'README.md': '# fixture\n',
  'AGENTS.md': 'internal agent notes\n',
  'docs/cloud.md': '# cloud\n',
  'docs/cloud-stages.md': '# internal stage plan\n',
  'docs/evidence-recovery.md': '# recovery runbook\n',
  'docs/release-export.md': '# export runbook\n',
  '.gitignore': 'node_modules/\n.env\n',
  'server/src/app.js': 'export const app = 1;\n',
  'web/index.html': '<!doctype html>\n',
  'functions/thumbnail/index.cjs': 'module.exports = {};\n',
  'infra/Dockerfile': 'FROM node:26\n',
  '.env.example': 'PORT=3000\nPOSTGRES_PASSWORD=local_dev_only\n',
  'scratch/notes.txt': 'not for release\n',
};
const EXPECTED_FILES = [
  '.env.example', '.gitignore', '.nvmrc', 'README.md', 'docs/cloud.md', 'docs/evidence-recovery.md', 'docs/release-export.md', 'functions/thumbnail/index.cjs',
  'infra/Dockerfile', 'package-lock.json', 'package.json', 'server/src/app.js', 'web/index.html',
].sort();

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

async function commit(repo, files, message) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await writeFile(path.join(repo, rel), content);
  }
  await git(repo, ['add', '-f', '-A']);
  await git(repo, ['commit', '-q', '-m', message]);
}

async function fixture(t, files = BASE_FILES) {
  const root = await mkdtemp(path.join(tmpdir(), 'export-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const out = path.join(root, 'out');
  await mkdir(repo);
  await mkdir(out);
  await git(repo, ['init', '-q']);
  await commit(repo, files, 'fixture');
  return {
    root,
    repo,
    out,
    output: path.join(out, 'release.tar.gz'),
    manifestPath: path.join(out, 'release.manifest.json'),
  };
}

async function runExport(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], { cwd, env: GIT_ENV });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

test('exports committed HEAD as allowlisted tar.gz with manifest and checksums', async (t) => {
  const { root, repo, output, manifestPath } = await fixture(t);
  const head = await git(repo, ['rev-parse', 'HEAD']);

  const run = await runExport(repo, ['--output', output]);
  assert.equal(run.code, 0, run.stderr);

  const archive = await readFile(output);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.source.commitSha, head);
  assert.equal(manifest.source.workingTree, 'clean');
  assert.equal(manifest.archive.sha256, sha256(archive));
  assert.equal(manifest.archive.bytes, archive.length);

  const prefix = `agridispatch-${head.slice(0, 12)}/`;
  const listing = (await execFileAsync('tar', ['-tzf', output])).stdout.split('\n').filter(Boolean);
  assert.ok(listing.includes(`${prefix}package.json`), listing.join('\n'));
  assert.ok(listing.every((entry) => !entry.includes('AGENTS.md') && !entry.includes('scratch/')));

  const extract = path.join(root, 'extract');
  await mkdir(extract);
  await execFileAsync('tar', ['-xzf', output, '-C', extract]);
  assert.deepEqual(manifest.files.map((file) => file.path).sort(), EXPECTED_FILES);
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(extract, prefix, file.path));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(sha256(bytes), file.sha256, file.path);
  }

  assert.deepEqual(
    manifest.excluded.map((entry) => entry.path).sort(),
    ['AGENTS.md', 'docs/cloud-stages.md', 'scratch/notes.txt'],
  );
  for (const entry of manifest.excluded) assert.ok(entry.reason, entry.path);
  assert.equal(manifest.labels.testsVerified, false);
  assert.equal(manifest.labels.deploymentVerified, false);
  assert.match(manifest.labels.aiAssistedContent, /AI-assisted/);
});

test('refuses modified tracked file and writes nothing', async (t) => {
  const { repo, output, manifestPath } = await fixture(t);
  await writeFile(path.join(repo, 'server/src/app.js'), 'export const app = 2;\n');

  const run = await runExport(repo, ['--output', output]);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /uncommitted|dirty/i);
  assert.equal(await exists(output), false);
  assert.equal(await exists(manifestPath), false);
});

test('refuses untracked file and writes nothing', async (t) => {
  const { repo, output, manifestPath } = await fixture(t);
  await writeFile(path.join(repo, 'untracked.txt'), 'draft\n');

  const run = await runExport(repo, ['--output', output]);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /uncommitted|dirty/i);
  assert.equal(await exists(output), false);
  assert.equal(await exists(manifestPath), false);
});

test('refuses output inside the repository worktree', async (t) => {
  const { repo } = await fixture(t);
  const output = path.join(repo, 'release.tar.gz');

  const run = await runExport(repo, ['--output', output]);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /outside the repository/);
  assert.equal(await exists(output), false);
  assert.equal(await exists(path.join(repo, 'release.manifest.json')), false);
});

test('refuses to overwrite an existing archive or manifest', async (t) => {
  const { repo, output, manifestPath } = await fixture(t);
  await writeFile(output, 'keep archive');
  let run = await runExport(repo, ['--output', output]);
  assert.notEqual(run.code, 0);
  assert.equal(await readFile(output, 'utf8'), 'keep archive');
  assert.equal(await exists(manifestPath), false);

  await rm(output);
  await writeFile(manifestPath, 'keep manifest');
  run = await runExport(repo, ['--output', output]);
  assert.notEqual(run.code, 0);
  assert.equal(await readFile(manifestPath, 'utf8'), 'keep manifest');
  assert.equal(await exists(output), false);
});

test('rejects malformed --sha before commit lookup', async (t) => {
  const { repo, output } = await fixture(t);
  const head = await git(repo, ['rev-parse', 'HEAD']);
  const badShas = ['main', 'HEAD~1', head.slice(0, 12), head.toUpperCase(), ` ${head}`];

  for (const sha of badShas) {
    const run = await runExport(repo, ['--output', output, '--sha', sha]);
    assert.notEqual(run.code, 0, sha);
    assert.match(run.stderr, /--sha must be HEAD or a full 40-character lowercase hex/, sha);
  }
  assert.equal(await exists(output), false);
});

test('refuses allowlisted secret-like filenames without writing output', async (t) => {
  for (const secretPath of ['server/config/.env.production', 'server/keys/tls.key', 'server/private/.env.example', 'infra/terraform/terraform.tfstate', 'infra/terraform/approved.tfplan', 'infra/terraform/prod.tfvars', 'infra/kubernetes/kubeconfig-prod', 'infra/terraform/.terraform/plugin']) {
    const { repo, output } = await fixture(t, { ...BASE_FILES, [secretPath]: 'X=1\n' });

    const run = await runExport(repo, ['--output', output]);
    assert.notEqual(run.code, 0, secretPath);
    assert.ok(run.stderr.includes(secretPath), run.stderr);
    assert.equal(await exists(output), false, secretPath);
  }
});

test('excludes non-allowlisted secret-like filenames with a reason', async (t) => {
  const { repo, output, manifestPath } = await fixture(t, { ...BASE_FILES, 'scratch/.env': 'X=1\n' });

  const run = await runExport(repo, ['--output', output]);
  assert.equal(run.code, 0, run.stderr);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entry = manifest.excluded.find((item) => item.path === 'scratch/.env');
  assert.ok(entry, 'scratch/.env must be listed as excluded');
  assert.match(entry.reason, /secret-like/);
  assert.ok(!manifest.files.some((file) => file.path === 'scratch/.env'));
});

test('rejects relative, non-tar.gz and missing output paths', async (t) => {
  const { root, repo } = await fixture(t);
  const cases = [
    ['--output', 'relative/release.tar.gz'],
    ['--output', path.join(root, 'release.zip')],
    [],
  ];

  for (const extra of cases) {
    const run = await runExport(repo, [...extra]);
    assert.notEqual(run.code, 0, extra.join(' '));
    assert.match(run.stderr, /--output/, extra.join(' '));
  }
});

test('exports an explicit older full commit instead of the working tree HEAD', async (t) => {
  const { root, repo, output, manifestPath } = await fixture(t);
  const first = await git(repo, ['rev-parse', 'HEAD']);
  await commit(repo, { 'package.json': '{"name":"second"}\n' }, 'second');

  const run = await runExport(repo, ['--output', output, '--sha', first]);
  assert.equal(run.code, 0, run.stderr);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.source.commitSha, first);

  const extract = path.join(root, 'extract');
  await mkdir(extract);
  await execFileAsync('tar', ['-xzf', output, '-C', extract]);
  const prefix = `agridispatch-${first.slice(0, 12)}/`;
  assert.equal(await readFile(path.join(extract, prefix, 'package.json'), 'utf8'), BASE_FILES['package.json']);
});

test('exports the whole allowed tree when invoked from a repository subdirectory', async (t) => {
  const { repo, output, manifestPath } = await fixture(t);
  const run = await runExport(path.join(repo, 'server'), ['--output', output]);
  assert.equal(run.code, 0, run.stderr);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(manifest.files.map((file) => file.path).sort(), EXPECTED_FILES);
});

test('rejects archive byte substitution by untracked Git info attributes', async (t) => {
  const { repo, output, manifestPath } = await fixture(t);
  await commit(repo, { 'README.md': '$Format:%H$\n' }, 'archive substitution fixture');
  await mkdir(path.join(repo, '.git/info'), { recursive: true });
  await writeFile(path.join(repo, '.git/info/attributes'), 'README.md export-subst\n');
  const run = await runExport(repo, ['--output', output]);
  assert.notEqual(run.code, 0, run.stderr);
  assert.match(run.stderr, /archive bytes differ/);
  assert.equal(await exists(output), false);
  assert.equal(await exists(manifestPath), false);
});
