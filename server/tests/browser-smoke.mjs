/* global URL, process, setTimeout, fetch, console */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';

// Run against a local disposable instance: node server/tests/browser-smoke.mjs http://127.0.0.1:33100.
// Creates one synthetic account, field and booking. Never point this at a shared dataset.
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:33100');
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname), 'Local disposable instance required');
const directory = await mkdtemp(join(tmpdir(), 'agridispatch-browser-'));
const output = join(process.env.TMPDIR ?? tmpdir(), 'cloud-start', 'ui-evidence');
await mkdir(output, { recursive: true });
const chrome = spawn(process.env.CHROMIUM_BIN ?? 'chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let n = 0;
const pending = new Map();
const errors = [];
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await sleep(100); }
  }
  assert.ok(port, 'Chromium did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new globalThis.WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
    if (msg.id) {
      const task = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) task.reject(new Error(JSON.stringify(msg.error))); else task.resolve(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++n; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(50); }
    throw new Error('DOM condition timed out: ' + expression);
  };
  const route = async (hash, condition) => {
    await evaluate(`location.hash=${JSON.stringify(hash)}`); await wait(condition);
  };
  const fill = async (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const click = async (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(join(output, name + '.png'), Buffer.from(data, 'base64'));
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "const nativeFetch=window.fetch;window.fetch=async(...a)=>{const r=await nativeFetch(...a);if(window.delayCatalog && String(a[0]).includes('/api/services?'))await new Promise(x=>setTimeout(x,500));return r}" });
  await send('Page.navigate', { url: origin.href });
  await wait("document.querySelectorAll('.card').length===3");
  await shot('desktop-catalog');
  if (process.argv.includes('--operations')) {
    const fixture=JSON.parse(await readFile(process.env.SYNTHETIC_LOGIN_FILE,'utf8'));
    const login=async(role)=>{
      await route('#login',"!!document.querySelector('#login-email')");
      await fill('#login-email',`synthetic-${role}@example.com`);await fill('#login-password',fixture.password);
      await click('form button[type=submit]');await wait("document.querySelector('#logout-button').hidden===false");
    };
    await login('operator');
    await route('#shifts',"[...document.querySelectorAll('button')].some(b=>b.textContent==='Bắt đầu ca')");
    await shot('operations-desktop-start');
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Bắt đầu ca').click()");
    await wait("location.hash.startsWith('#shift/') && !!document.querySelector('#shift-reason')");
    const shiftHash=await evaluate('location.hash');
    await shot('operations-desktop-running');
    await click('form button[type=submit]');assert.equal(await evaluate('document.activeElement.id'),'shift-reason');
    await fill('#shift-reason','Mưa mô phỏng');await click('form button[type=submit]');
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Tiếp tục ca')");
    await shot('operations-desktop-paused');
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Tiếp tục ca').click()");
    await wait("!!document.querySelector('#shift-area')");
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    await fill('#shift-area','12001');await evaluate("document.querySelector('#shift-area').closest('form').requestSubmit()");
    await wait("document.querySelector('main').innerText.includes('Diện tích vượt tổng')");
    console.log('OPERATIONS_LAYOUT',JSON.stringify(await evaluate(`({innerWidth,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,controls:[...document.querySelectorAll('input,button')].map(e=>({text:e.id||e.textContent,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}))})`)));
    assert.ok(await evaluate('[...document.querySelectorAll("input,button")].every(e=>e.getBoundingClientRect().right<=document.documentElement.clientWidth)'), 'Control clipped by viewport');
    await shot('operations-mobile-area-error');
    await fill('#shift-area','12000');await fill('#shift-note','Hoàn thành mô phỏng, chưa nghiệm thu');
    await evaluate("document.querySelector('#shift-area').closest('form').requestSubmit()");
    await wait("!document.querySelector('#shift-area') && document.querySelector('main').innerText.includes('Diện tích đã ghi: 12000 m²')");
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
    assert.equal(await evaluate("document.querySelectorAll('.timeline li').length"),4);
    await shot('operations-mobile-completed');
    await click('#logout-button');await wait("!!document.querySelector('#login-email')");await login('provider');
    await route(shiftHash,"!!document.querySelector('.timeline')");
    assert.equal(await evaluate("document.querySelectorAll('main form').length"),0);
    await shot('operations-mobile-provider-readonly');
    assert.deepEqual(errors,[]);
    console.log('OPERATIONS_BROWSER_PASS: real gateway assigned operator start/pause/resume/complete, area rejection and provider read-only; desktop/mobile.');
  } else if (process.argv.includes('--recruitment')) {
    const fixture = JSON.parse(await readFile(process.env.SYNTHETIC_LOGIN_FILE, 'utf8'));
    const login = async (role) => {
      await route('#login', "!!document.querySelector('#login-email')");
      await fill('#login-email', `synthetic-${role}@example.com`); await fill('#login-password', fixture.password);
      await click('form button[type=submit]'); await wait("document.querySelector('#logout-button').hidden===false");
    };
    const logout = async () => { await click('#logout-button'); await wait("location.hash==='#login' && !!document.querySelector('#login-email')"); };
    await login('provider');
    await route('#my-jobs', "!!document.querySelector('#job-title')");
    const jobTitle = 'Tin tuyển mô phỏng ' + randomBytes(4).toString('hex');
    for (const [selector,value] of [['#job-title',jobTitle],['#job-locality','Địa bàn mô phỏng'],['#job-capacity','1'],['#job-startLocal','2026-12-02T08:00'],['#job-endLocal','2026-12-02T12:00']]) await fill(selector,value);
    await click('form button[type=submit]');
    await wait(`[...document.querySelectorAll('a[href^="#job/"]')].some(a=>a.textContent===${JSON.stringify(jobTitle)})`);
    const jobHash = await evaluate(`[...document.querySelectorAll('a[href^="#job/"]')].find(a=>a.textContent===${JSON.stringify(jobTitle)}).getAttribute('href')`);
    await shot('recruitment-provider-created');
    await logout(); await login('operator');
    await route(jobHash, "!!document.querySelector('#application-note')");
    await fill('#application-note','Ứng tuyển mô phỏng, chưa phải nhận việc');
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Ứng tuyển').click()");
    await wait("location.hash==='#applications' && !!document.querySelector('.card')");
    await shot('recruitment-operator-applied');
    await logout(); await login('provider');
    await route(jobHash, "[...document.querySelectorAll('button')].some(b=>b.textContent==='Gửi đề nghị')");
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Gửi đề nghị').click()");
    await wait("document.querySelector('main').innerText.includes('Đã gửi đề nghị')");
    await logout(); await login('operator');
    await route('#offers', "[...document.querySelectorAll('button')].some(b=>b.textContent==='Nhận đề nghị')");
    await send('Emulation.setDeviceMetricsOverride', { width:390,height:844,deviceScaleFactor:1,mobile:false });
    await shot('recruitment-mobile-offer');
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Nhận đề nghị').click()");
    await wait("document.querySelector('main').innerText.includes('Đã nhận đề nghị')");
    await shot('recruitment-mobile-accepted');
    await logout(); await login('provider');
    await route(jobHash, "document.querySelector('main').innerText.includes('1/1 chỗ đã nhận')");
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Đóng tin tuyển').click()");
    await wait("document.querySelector('main').innerText.includes('Đã đóng')");
    await shot('recruitment-mobile-closed');
    assert.deepEqual(errors, []);
    console.log('RECRUITMENT_BROWSER_PASS: provider create/offer/close and operator apply/accept through real account gateway. Screenshots: '+output);
    process.exitCode=0;
  } else {
  // Real delayed fetch reproduces stale results crossing a hash navigation.
  const raced = await evaluate(`(async()=>{
    window.delayCatalog=true;
    location.hash='#login';await new Promise(x=>setTimeout(x,30));location.hash='#services';await new Promise(x=>setTimeout(x,60));location.hash='#login';await new Promise(x=>setTimeout(x,700));window.delayCatalog=false;
    return {hash:location.hash,heading:document.querySelector('h1').textContent};})()`);
  assert.deepEqual(raced, { hash: '#login', heading: 'Đăng nhập' }, 'Stale catalog response overwrote login');
  await route('#register', "!!document.querySelector('#reg-email')");
  const email = `synthetic-${randomBytes(6).toString('hex')}@example.com`;
  const password = randomBytes(18).toString('base64url');
  await fill('#reg-name', 'Nông dân mô phỏng'); await fill('#reg-email', email); await fill('#reg-password', password);
  await click('form button[type=submit]'); await wait("location.hash==='#login' && !!document.querySelector('#login-email')");
  await fill('#login-email', email); await fill('#login-password', password); await click('form button[type=submit]');
  await wait("document.querySelector('#logout-button').hidden===false");
  await route('#fields', "!!document.querySelector('#field-name')");
  await shot('desktop-empty-fields');
  await click('form button[type=submit]');
  assert.equal(await evaluate('document.activeElement.id'), 'field-name');
  await fill('#field-name', 'Thửa mô phỏng'); await fill('#field-locality', 'Địa bàn mô phỏng'); await fill('#field-area', '12000');
  await click('form button[type=submit]'); await wait("document.querySelector('.card')?.innerText.includes('Thửa mô phỏng')");
  await route('#services/00000000-0000-4000-8000-000000000102', "!!document.querySelector('a[href^=\"#request/\"]')");
  await shot('desktop-detail');
  await click('a[href^="#request/"]'); await wait("!!document.querySelector('#booking-start')");
  await click('form button[type=submit]');
  assert.equal(await evaluate('document.activeElement.id'), 'booking-field');
  await evaluate("document.querySelector('#booking-field').selectedIndex=1");
  await fill('#booking-start', '2026-12-01T08:00'); await fill('#booking-end', '2026-12-01T12:00');
  await shot('desktop-request');
  await click('form button[type=submit]');
  await wait("location.hash.startsWith('#booking/') && !!document.querySelector('.timeline')");
  assert.ok(await evaluate("document.querySelector('main').innerText.includes('1.440.000 VND')"));
  await shot('desktop-booking');
  await route('#bookings', "!!document.querySelector('.card')");
  await shot('desktop-bookings');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  for (const hash of ['#services', '#fields', '#bookings']) {
    await route(hash, `location.hash===${JSON.stringify(hash)} && !!document.querySelector('.card')`); await sleep(100);
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'), hash + ' overflows');
    await shot('mobile-' + hash.slice(1));
  }
  // Skip-link keyboard activation must focus main without destroying current route.
  await evaluate("document.querySelector('.skip-link').focus()");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(100);
  assert.equal(await evaluate('document.activeElement.id'), 'main');
  assert.equal(await evaluate('location.hash'), '#bookings');
  await click('#logout-button'); await wait("location.hash==='#login' && !!document.querySelector('#login-email')");
  assert.ok(await evaluate("document.querySelector('#logout-button').hidden"));
  await shot('mobile-login');
  assert.deepEqual(errors, []);
  console.log('BROWSER_SMOKE_PASS: gateway registration/login/field/booking/history/logout, responsive, skip-link, navigation race. Screenshots: ' + output);
  }
} finally {
  socket?.close(); chrome.kill('SIGTERM');
  await sleep(200); if (chrome.exitCode === null) chrome.kill('SIGKILL');
  await rm(directory, { recursive: true, force: true });
}
