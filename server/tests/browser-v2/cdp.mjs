// Minimal CDP driver for local checks of web/v2. Usage: import { open } from './cdp.mjs'.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function open({ width = 390, height = 844, mobile = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'v2-'));
  const chrome = spawn(process.env.CHROMIUM_BIN || 'chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => { chrome.once('error', resolve); chrome.once('exit', resolve); });
  let ws;
  async function close() {
    ws?.close();
    chrome.kill();
    await exited;
    // Chromium subprocesses may finish writing their profile just after the parent exits.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  try {
    let port;
    for (let i = 0; i < 100 && !port; i++) { try { port = (await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await sleep(100); } }
    if (!port) throw new Error('Chromium DevTools did not start');
    const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page');
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let n = 0;
    const pend = new Map();
    const errors = [];
    const consoleErrors = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.slice(0, 300) || m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300));
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.slice(0, 300));
      if (m.id) { pend.get(m.id)(m); pend.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(`eval failed: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
      return r.result?.result?.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    const api = {
      errors, consoleErrors, ev, send, sleep,
      async go(url) { await send('Page.navigate', { url }); await sleep(800); },
      async hash(h) { await ev(`location.hash=${JSON.stringify(h)}`); await sleep(600); },
      async waitFor(expr, ms = 8000) {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await ev(`!!(${expr})`)) return true; await sleep(100); }
        throw new Error(`timeout waiting for ${expr}`);
      },
      async waitText(text, ms = 8000) { return api.waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, ms); },
      async fill(selector, value) {
        await ev(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('no '+${JSON.stringify(selector)});el.focus();el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      },
      async click(selector) { await ev(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('no '+${JSON.stringify(selector)});el.click();})()`); await sleep(300); },
      async clickText(text, tag = 'button,a') {
        await ev(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(tag)})].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&e.offsetParent!==null);if(!el)throw new Error('no element with text '+${JSON.stringify(text)});el.click();})()`);
        await sleep(300);
      },
      async layout() {
        return ev(`(()=>{const w=innerWidth;const wide=[...document.querySelectorAll('body *')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.right>w+1&&getComputedStyle(e).position!=='fixed'}).slice(0,3).map(e=>e.tagName+'.'+String(e.className).slice(0,40)+':'+Math.round(e.getBoundingClientRect().right));return {w,sw:document.documentElement.scrollWidth,wide,h1:(document.querySelector('h1')||{}).textContent}})()`);
      },
      async shot(path) {
        const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(path, Buffer.from(r.result.data, 'base64'));
        return path;
      },
      async viewport(w, h, m) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: m }); await sleep(300); },
      close,
    };
    return api;
  } catch (err) {
    await close();
    throw err;
  }
}
