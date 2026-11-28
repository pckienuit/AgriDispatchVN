/* global process, console, setInterval */
// Unit-test double for server/tests/helpers/operations-browser-server.mjs. Same stdout and signal contract, no DB.
import { appendFile, writeFile } from 'node:fs/promises';

const mode = process.env.FAKE_FIXTURE ?? 'ok';
const markFile = process.env.FAKE_MARK;
const loginFile = process.env.SYNTHETIC_LOGIN_FILE;

if (mode === 'crash') {
  console.error('fake fixture crash before readiness');
  process.exit(3);
}
if (mode === 'no-ready') {
  setInterval(() => {}, 1000);
} else {
  if (loginFile) {
    // Mirrors the real fixture: synthetic password only in the 0600 login file.
    await writeFile(loginFile, JSON.stringify({ password: 'fake-password-7f3a', bookingId: 'b', coopId: 'c' }));
  }
  console.log('OPERATIONS_SMOKE_READY');
  if (mode === 'ignore-term') process.on('SIGTERM', () => {});
  else {
    process.on('SIGTERM', async () => {
      if (markFile) await appendFile(markFile, 'SIGTERM\n');
      process.exit(0);
    });
  }
  setInterval(() => {}, 1000);
}
