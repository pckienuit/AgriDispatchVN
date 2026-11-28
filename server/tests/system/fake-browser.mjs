/* global process, console, Buffer, setInterval */
// Unit-test double for server/tests/browser-smoke.mjs. Writes a screenshot into $TMPDIR/cloud-start/ui-evidence
// like the real driver and prints the pass marker for the requested mode.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const mode = process.env.FAKE_BROWSER ?? 'ok';
const args = process.argv.slice(3);
const marker = args.includes('--recruitment')
  ? 'RECRUITMENT_BROWSER_PASS'
  : args.includes('--operations') || args.includes('--dispatch')
    ? 'OPERATIONS_BROWSER_PASS'
    : 'BROWSER_SMOKE_PASS';

// Keep the event loop alive so the hang is real; a never-settling top-level await exits with code 13 instead.
if (mode === 'hang') setInterval(() => {}, 1000);
if (mode === 'fail') {
  console.error('AssertionError: synthetic failure');
  process.exit(1);
}
if (process.env.FAKE_BROWSER_MARK) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(process.env.FAKE_BROWSER_MARK, `TMPDIR=${process.env.TMPDIR}\n`);
}
const dir = join(process.env.TMPDIR, 'cloud-start', 'ui-evidence');
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'desktop-catalog.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
if (mode === 'echo-secret') {
  const login = JSON.parse(await readFile(process.env.SYNTHETIC_LOGIN_FILE, 'utf8'));
  console.log(`debug password=${login.password}`);
}
if (mode !== 'no-marker') console.log(marker);
