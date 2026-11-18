// Export a clean source handoff: committed HEAD (or explicit full SHA), allowlisted paths only.
// Usage (run inside the repo worktree): node server/scripts/export-release.js --output /abs/dir/release.tar.gz [--sha HEAD|<40-hex>]
// Writes release.tar.gz (git archive) and release.manifest.json next to it. Never overwrites.
// ponytail: no content scan; secrets are rejected by filename only (spec: never read secret contents).
// Ceiling: a real secret under an allowlisted non-secret name ships. Upgrade: reviewed content scanner.
// ponytail: whole archive read into memory for hashing. Ceiling: ~hundreds of MB. Upgrade: stream hash.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);
const MAX_BUFFER = 512 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const ALLOW_FILES = new Set(['.dockerignore', '.editorconfig', '.gitignore', '.env.example', '.nvmrc', 'README.md', 'eslint.config.js', 'package-lock.json', 'package.json', 'Jenkinsfile', 'azure-pipelines.yml']);
const ALLOW_PREFIXES = ['server/', 'db/', 'web/', 'infra/', 'functions/', '.github/workflows/'];
// docs/cloud-stages.md is internal planning and approval text: deliberately not allowlisted.
const ALLOW_DOCS = new Set(['api', 'architecture', 'development', 'cloud', 'synthetic-data', 'benchmark', 'benchmark-bookings', 'evidence-recovery', 'release-export', 'testing', 'terraform', 'cloud-deploy', 'pipelines', 'database-deploy'].map((n) => `docs/${n}.md`));
const SECRET_NAME = /(^|\/)(\.env(\..+)?|\.npmrc|\.netrc|\.htpasswd|credentials(\.json)?|id_(rsa|ecdsa|ed25519)|auth\.json)$|\.(pem|key|p12|pfx)$|(^|\/)(private|node_modules)\//;
const ENV_EXAMPLE = /(^|\/)\.env\.example$/;
const DEPLOY_SECRET = /(^|\/)(backend\.hcl$|\.terraform\/|kubeconfig[^/]*$|[^/]*-kubeconfig$)|\.(tfstate(\..*)?|tfplan|tfvars(\.json)?)$/;

const allowed = (p) => ALLOW_FILES.has(p) || ALLOW_DOCS.has(p) || ALLOW_PREFIXES.some((prefix) => p.startsWith(prefix));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (args, cwd) => run('git', ['--literal-pathspecs', ...args], { cwd, encoding: 'buffer', maxBuffer: MAX_BUFFER }).then((r) => r.stdout);
const text = (buf) => buf.toString('utf8').trim();
const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const exists = (file) => lstat(file).then(() => true, () => false);

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { output: { type: 'string' }, sha: { type: 'string' } },
    strict: true,
  });
  const sha = values.sha ?? 'HEAD';
  if (!values.output) throw new Error('--output is required');
  if (!path.isAbsolute(values.output) || !values.output.endsWith('.tar.gz')) throw new Error('--output must be an absolute path ending in .tar.gz');
  if (sha !== 'HEAD' && !SHA.test(sha)) throw new Error('--sha must be HEAD or a full 40-character lowercase hex SHA');
  return { output: values.output, sha };
}

async function main() {
  const { output, sha } = parseOptions(process.argv.slice(2));
  let cwd = process.cwd();
  const manifest = output.replace(/\.tar\.gz$/, '.manifest.json');

  const repo = await realpath(text(await git(['rev-parse', '--show-toplevel'], cwd)));
  cwd = repo;
  const outDir = await realpath(path.dirname(output)).catch(() => { throw new Error('output directory must exist'); });
  if (isInside(outDir, repo)) throw new Error('output must be outside the repository worktree');
  for (const file of [output, manifest]) if (await exists(file)) throw new Error(`refusing to overwrite ${file}`);

  const status = text(await git(['status', '--porcelain', '--untracked-files=all'], cwd));
  if (status) throw new Error('working tree has uncommitted or untracked changes; commit or stash before export');

  const commit = await git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], cwd)
    .then(text, () => { throw new Error(`--sha ${sha} does not resolve to a commit`); });
  if (!SHA.test(commit)) throw new Error(`--sha ${sha} does not resolve to a commit`);

  const listing = (await git(['ls-tree', '-r', '-z', '--full-tree', commit], cwd)).toString('utf8').split('\0').filter(Boolean);
  const entries = listing.map((line) => {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t([\s\S]+)$/.exec(line);
    if (!m) throw new Error(`unparsable ls-tree line for ${line}`);
    return { mode: m[1], type: m[2], oid: m[3], path: m[4] };
  });
  if (entries.some((e) => e.path.split('/').pop() === '.gitattributes')) throw new Error('refusing export: tracked .gitattributes can change archive bytes');

  const included = [];
  const excluded = [];
  for (const e of entries) {
    if ((SECRET_NAME.test(e.path) && !ENV_EXAMPLE.test(e.path)) || DEPLOY_SECRET.test(e.path) || /(^|\/)(private|node_modules)\//.test(e.path)) {
      if (allowed(e.path)) throw new Error(`refusing export: secret-like tracked path ${e.path}`);
      excluded.push({ path: e.path, reason: 'secret-like filename' });
    } else if (!allowed(e.path)) {
      excluded.push({ path: e.path, reason: 'outside release allowlist' });
    } else if (e.type !== 'blob' || (e.mode !== '100644' && e.mode !== '100755')) {
      excluded.push({ path: e.path, reason: `not a regular file (mode ${e.mode})` });
    } else {
      included.push(e);
    }
  }
  if (included.length === 0) throw new Error('allowlist matched no tracked files; refusing to archive whole tree');

  const files = [];
  for (const e of included) {
    const bytes = await git(['cat-file', 'blob', e.oid], cwd);
    files.push({ path: e.path, mode: e.mode, bytes: bytes.length, sha256: sha256(bytes) });
  }

  const prefix = `agridispatch-${commit.slice(0, 12)}/`;
  const commitDate = text(await git(['log', '-1', '--format=%cI', commit], cwd));
  await writeFile(output, '', { flag: 'wx' });
  let wroteManifest = false;
  try {
    await git(['archive', '--format=tar.gz', `--prefix=${prefix}`, `--output=${output}`, commit, '--', ...files.map((f) => f.path)], cwd);
    const listed = (await run('tar', ['-tzf', output], { encoding: 'utf8', maxBuffer: MAX_BUFFER })).stdout.split('\n').filter(Boolean);
    const expected = new Set(files.map((f) => prefix + f.path));
    for (const name of expected) if (!listed.includes(name)) throw new Error(`archive missing ${name}`);
    for (const name of listed) if (!name.endsWith('/') && !expected.has(name)) throw new Error(`archive has unexpected entry ${name}`);
    // Git info/global attributes are outside the committed tree; verify actual archived bytes too.
    for (const file of files) {
      const { stdout } = await run('tar', ['-xOzf', output, '--', prefix + file.path], { encoding: 'buffer', maxBuffer: MAX_BUFFER });
      if (stdout.length !== file.bytes || sha256(stdout) !== file.sha256) throw new Error(`archive bytes differ for ${file.path}`);
    }

    const archive = await readFile(output);
    const body = {
      schema: 'agridispatch-release-export/1',
      source: { commitSha: commit, workingTree: 'clean', commitDate, exportRunDate: new Date().toISOString() },
      archive: { file: path.basename(output), format: 'tar.gz', prefix, bytes: archive.length, sha256: sha256(archive) },
      counts: { included: files.length, excluded: excluded.length },
      files,
      excluded,
      labels: {
        scope: 'committed tree only, allowlisted paths; no working-tree files, no environment values',
        secretContents: 'not read for rejected paths; included files not content-scanned',
        aiAssistedContent: 'AI-assisted: this technical source includes AI-assisted code and documents',
        testsVerified: false,
        deploymentVerified: false,
        publicReleaseApproved: false,
        privacyReviewed: false,
      },
    };
    await writeFile(manifest, `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx' });
    wroteManifest = true;
    console.log(`archive ${output}\nmanifest ${manifest}\ncommit ${commit}\nincluded ${files.length} excluded ${excluded.length}`);
  } catch (error) {
    await rm(output, { force: true });
    if (wroteManifest) await rm(manifest, { force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(`export-release: ${error.message}`);
  process.exitCode = 1;
});
