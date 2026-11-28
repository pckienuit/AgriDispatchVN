import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { evidenceErrorMessage, evidenceId, readEvidencePage, renderEvidence, validateEvidenceFile } from '../../web/evidence.js';

const ID = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DISPUTE = ID(1);
const EV = ID(50);
const EV2 = ID(51);
const NOW = '2026-11-20T03:00:00.000Z';
const MB = 1024 * 1024;
const LIST = `/api/disputes/${DISPUTE}/evidence?limit=20&offset=0`;
const UPLOAD = `/api/disputes/${DISPUTE}/evidence`;
const item = (over = {}) => ({ id: EV, status: 'UPLOADED', contentType: 'image/jpeg', byteSize: 2048, width: 1200, height: 800, createdAt: NOW, ...over });
const page = (over = {}) => ({ items: [item()], limit: 20, offset: 0, canUpload: true, storageAvailable: true, ...over });
const jpeg = (over = {}) => ({ name: 'anh-dong.jpg', type: 'image/jpeg', size: 300 * 1024, ...over });
const coded = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const blob = (type = 'image/jpeg') => new globalThis.Blob(['x'], { type });

// ---- pure helpers -----------------------------------------------------------

test('evidence id accepts uuid case-insensitively and rejects path-like text', () => {
  assert.equal(evidenceId(EV.toUpperCase()), EV);
  for (const value of ['', 'x', `${EV}/x`, `../${EV}`, `${EV}?x=1`, null, 42]) assert.equal(evidenceId(value), null, String(value));
});

test('file check accepts JPEG and PNG up to 5 MiB and refuses everything else', () => {
  assert.equal(validateEvidenceFile(jpeg()), null);
  assert.equal(validateEvidenceFile({ type: 'image/png', size: 5 * MB }), null);
  assert.equal(validateEvidenceFile(jpeg({ size: 5 * MB + 1 })), 'Ảnh vượt quá 5 MB. Chọn ảnh nhỏ hơn.');
  assert.notEqual(validateEvidenceFile(jpeg({ size: 0 })), null);
  assert.notEqual(validateEvidenceFile(null), null);
  for (const type of ['image/gif', 'image/webp', 'image/jpg', 'application/pdf', '']) {
    assert.match(validateEvidenceFile(jpeg({ type })), /JPEG hoặc PNG/, type);
  }
  assert.doesNotMatch(validateEvidenceFile(jpeg({ type: 'image/gif' })), /anh-dong/, 'file name never echoed');
});

test('page reader accepts the agreed shape and refuses every other shape', () => {
  assert.deepEqual(readEvidencePage(page(), 0), page());
  assert.equal(readEvidencePage(page({ items: [], canUpload: false, storageAvailable: false }), 0).storageAvailable, false);
  for (const bad of [
    page({ items: [item({ status: 'DELETED' })] }),
    page({ items: [item({ contentType: 'image/gif' })] }),
    page({ items: [item({ byteSize: -1 })] }),
    page({ items: [item({ width: 0 })] }),
    page({ items: [item({ height: 1.5 })] }),
    page({ items: [item({ id: 'nope' })] }),
    page({ items: [item({ createdAt: 'yesterday' })] }),
    page({ canUpload: 'yes' }),
    page({ storageAvailable: undefined }),
    page({ offset: 20 }),
    page({ items: 'none' }),
    null,
  ]) {
    assert.equal(readEvidencePage(bad, 0), null, JSON.stringify(bad).slice(0, 60));
  }
});

test('error copy maps known codes, treats uncertain writes and never echoes unknown codes', () => {
  for (const code of ['INVALID_IMAGE', 'UNSUPPORTED_MEDIA_TYPE', 'PAYLOAD_TOO_LARGE', 'STORAGE_UNAVAILABLE', 'DISPUTE_NOT_OPEN', 'UPLOAD_PENDING', 'EVIDENCE_LIMIT', 'NOT_FOUND', 'UNAUTHENTICATED']) {
    const message = evidenceErrorMessage({ code, status: 400 });
    assert.ok(message.length > 0, code);
    assert.doesNotMatch(message, new RegExp(code), code);
  }
  assert.match(evidenceErrorMessage({ code: 'UNAUTHENTICATED', status: 401 }), /đăng nhập/);
  assert.match(evidenceErrorMessage(coded('TIMEOUT', { uncertain: true })), /Tải lại/);
  assert.match(evidenceErrorMessage(coded('WHATEVER', { uncertain: true })), /Tải lại/);
  for (const code of ['SOME_NEW_CODE', 'constructor', '__proto__', undefined]) {
    const message = evidenceErrorMessage({ code, status: 500 });
    assert.match(message, /Tải lại/);
    assert.doesNotMatch(message, /SOME_NEW|constructor|__proto__|undefined/);
  }
});

test('module has no HTML sinks, storage, direct URLs or dashes', async () => {
  const text = await readFile(new URL('../../web/evidence.js', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|indexedDB|\beval\(|new Function\(/);
  assert.doesNotMatch(text, /https?:\/\/|localhost|127\.0\.0\.1|token=/);
  assert.doesNotMatch(text, /[\u2013\u2014]/);
});

// ---- render through a minimal DOM double (no dependency) --------------------

const FOCUS = { last: null };
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.attrs = {}; this.children = []; this.parent = null;
    this.listeners = {}; this.text = ''; this.value = ''; this.files = []; this.hidden = false; this.disabled = false;
  }
  get isConnected() { return true; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; this.text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...nodes) { for (const n of nodes) if (n) { n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes) { for (const c of this.children) c.parent = null; this.children = []; this.text = ''; this.append(...nodes); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } }
  addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
  dispatch(ev, extra = {}) { for (const fn of this.listeners[ev] ?? []) fn({ preventDefault() {}, ...extra }); }
  click() { this.dispatch('click'); }
  focus() { FOCUS.last = this; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const take = async (queue) => { const value = await queue.shift(); if (value instanceof Error) throw value; return value; };
const find = (root, tag, pred = () => true) => root.all().find((n) => n.tagName === tag && pred(n));
const btn = (root, prefix) => root.all().find((n) => n.tagName === 'BUTTON' && n.textContent.startsWith(prefix));
const submitButton = (root) => find(root, 'BUTTON', (n) => n.attrs.type === 'submit');
const pick = (root, chosen) => { const input = find(root, 'INPUT'); input.files = [chosen]; input.dispatch('change'); };
const submit = (root) => find(root, 'FORM').dispatch('submit');
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

async function mount({ responses = [], uploads = [], binaries = [], active = true, disputeId = DISPUTE } = {}) {
  const calls = []; const announced = []; const made = []; const created = []; const revoked = [];
  globalThis.document = { createElement: (tag) => { const node = new FakeNode(tag); made.push(node); return node; } };
  URL.createObjectURL = () => { const url = `blob:t/${created.length}`; created.push(url); return url; };
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  const state = { on: active };
  const api = {
    request: async (method, path) => { calls.push(`${method} ${path}`); return { data: await take(responses) }; },
    upload: async (path) => { calls.push(`UPLOAD ${path}`); return take(uploads); },
    binary: async (path) => { calls.push(`BINARY ${path}`); return take(binaries); },
  };
  const container = new FakeNode('div');
  const cleanup = await renderEvidence({ container, api, active: () => state.on, announce: (t) => announced.push(t), disputeId });
  await flush();
  return { container, calls, announced, made, created, revoked, cleanup, state };
}

test('invalid dispute id shows a message and makes no request', async () => {
  const { container, calls } = await mount({ disputeId: 'not-an-id', responses: [page()] });
  assert.equal(calls.length, 0);
  assert.match(container.textContent, /không hợp lệ/);
});

test('list shows loaded items and fetches no image until asked', async () => {
  const { container, calls, made } = await mount({ responses: [page()] });
  assert.deepEqual(calls, [`GET ${LIST}`]);
  assert.match(container.textContent, /Ảnh 1/);
  assert.match(container.textContent, /1200 × 800 px/);
  assert.equal(made.some((n) => n.tagName === 'IMG'), false);
});

test('no upload form when the server refuses upload, and the real reason is stated', async () => {
  const noRight = await mount({ responses: [page({ items: [], canUpload: false })] });
  assert.equal(find(noRight.container, 'FORM'), undefined);
  assert.match(noRight.container.textContent, /Chưa có ảnh bằng chứng/);
  assert.match(noRight.container.textContent, /chưa thể thêm bằng chứng/);
  const noStorage = await mount({ responses: [page({ items: [], storageAvailable: false })] });
  assert.equal(find(noStorage.container, 'FORM'), undefined);
  assert.match(noStorage.container.textContent, /chưa được cấu hình/);
});

test('disclosure about GPS metadata comes before the file input', async () => {
  const { container } = await mount({ responses: [page()] });
  const nodes = container.all();
  const disclosure = nodes.findIndex((n) => /GPS/.test(n.text));
  assert.ok(disclosure >= 0);
  assert.ok(disclosure < nodes.indexOf(find(container, 'INPUT')));
  assert.match(container.textContent, /không phải bằng chứng xác thực/);
  assert.match(container.textContent, /không phải bước xác minh/);
});

test('invalid file shows a message, sends nothing and never echoes the file name', async () => {
  const { container, calls } = await mount({ responses: [page()] });
  pick(container, { name: 'secret-gps.gif', type: 'image/gif', size: 10 });
  assert.match(container.textContent, /JPEG hoặc PNG/);
  assert.equal(submitButton(container).disabled, true);
  submit(container);
  assert.equal(calls.filter((c) => c.startsWith('UPLOAD')).length, 0);
  assert.doesNotMatch(container.textContent, /secret-gps/);
});

test('valid file enables upload and feedback shows type and size, not the file name', async () => {
  const { container } = await mount({ responses: [page()] });
  pick(container, jpeg());
  assert.equal(submitButton(container).disabled, false);
  assert.match(container.textContent, /Đã chọn ảnh JPEG/);
  assert.doesNotMatch(container.textContent, /anh-dong/);
});

test('upload is confirmed by a fresh list read, then announced and cleared', async () => {
  const { container, calls, announced } = await mount({
    responses: [page({ items: [] }), page({ items: [item()] })],
    uploads: [{ data: { evidence: { id: EV } }, status: 201 }],
  });
  pick(container, jpeg());
  submit(container);
  await flush();
  assert.deepEqual(calls, [`GET ${LIST}`, `UPLOAD ${UPLOAD}`, `GET ${LIST}`]);
  assert.deepEqual(announced, ['Đã tải ảnh bằng chứng.']);
  assert.equal(find(container, 'INPUT').value, '');
});

test('a success reply missing from the fresh list is not reported as success', async () => {
  const { container, announced } = await mount({
    responses: [page({ items: [] }), page({ items: [] })],
    uploads: [{ data: { evidence: { id: EV2 } }, status: 201 }],
  });
  pick(container, jpeg());
  submit(container);
  await flush();
  assert.deepEqual(announced, []);
  assert.match(container.textContent, /Chưa xác nhận/);
});

test('uncertain upload reloads the list first and does not announce success', async () => {
  const { container, calls, announced } = await mount({
    responses: [page({ items: [] }), page({ items: [item()] })],
    uploads: [coded('TIMEOUT', { uncertain: true })],
  });
  pick(container, jpeg());
  submit(container);
  await flush();
  assert.deepEqual(calls, [`GET ${LIST}`, `UPLOAD ${UPLOAD}`, `GET ${LIST}`]);
  assert.deepEqual(announced, []);
  assert.match(container.textContent, /Chưa xác nhận/);
});

test('upload in flight disables controls and ignores a second submit', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { container, calls, announced } = await mount({
    responses: [page({ items: [] }), page({ items: [item()] })],
    uploads: [pending],
  });
  pick(container, jpeg());
  submit(container);
  submit(container);
  assert.equal(calls.filter((c) => c.startsWith('UPLOAD')).length, 1);
  assert.equal(find(container, 'INPUT').disabled, true);
  assert.equal(submitButton(container).disabled, true);
  release({ data: { evidence: { id: EV } }, status: 201 });
  await flush();
  assert.deepEqual(announced, ['Đã tải ảnh bằng chứng.']);
});

test('known upload error shows its own copy and never announces success', async () => {
  const { container, calls, announced } = await mount({
    responses: [page({ items: [] })],
    uploads: [coded('PAYLOAD_TOO_LARGE', { status: 413 })],
  });
  pick(container, jpeg());
  submit(container);
  await flush();
  assert.equal(calls.length, 2, 'no confirming reload for a refused upload');
  assert.match(container.textContent, /vượt quá 5 MB/);
  assert.deepEqual(announced, []);
});

test('thumbnail becomes a blob image and a refresh revokes the previous url', async () => {
  const { container, calls, created, revoked } = await mount({ responses: [page()], binaries: [blob(), blob()] });
  btn(container, 'Xem ảnh thu nhỏ').click();
  await flush();
  assert.equal(find(container, 'IMG').attrs.src, 'blob:t/0');
  btn(container, 'Xem ảnh thu nhỏ').click();
  await flush();
  assert.equal(find(container, 'IMG').attrs.src, 'blob:t/1');
  assert.deepEqual(revoked, ['blob:t/0']);
  assert.equal(created.length, 2);
  assert.ok(calls.includes(`BINARY /api/evidence/${EV}/thumbnail`));
});

test('pending thumbnail shows a pending note, not an image', async () => {
  const { container } = await mount({ responses: [page()], binaries: [coded('THUMBNAIL_PENDING', { status: 404 })] });
  btn(container, 'Xem ảnh thu nhỏ').click();
  await flush();
  assert.equal(find(container, 'IMG'), undefined);
  assert.match(container.textContent, /đang được chuẩn bị/);
});

test('original download uses a temporary url with the typed file name and revokes on cleanup', async () => {
  const { container, calls, made, revoked, cleanup } = await mount({
    responses: [page({ items: [item({ contentType: 'image/png' })] })],
    binaries: [blob('image/png')],
  });
  btn(container, 'Tải ảnh gốc').click();
  await settle();
  assert.ok(calls.includes(`BINARY /api/evidence/${EV}/content`));
  const link = made.find((n) => n.tagName === 'A');
  assert.equal(link.attrs.download, `bang-chung-${EV}.png`);
  assert.equal(link.attrs.href, 'blob:t/0');
  assert.equal(link.parent, null, 'temporary link never attached to the page');
  assert.equal(revoked.length, 0, 'url stays alive briefly so the browser can start the download');
  cleanup();
  assert.ok(revoked.includes('blob:t/0'), 'cleanup revokes a pending download url');
});

test('pager asks the next page at offset 20 and disables previous on the first page', async () => {
  const full = Array.from({ length: 20 }, (_, i) => item({ id: ID(100 + i) }));
  const { container, calls } = await mount({ responses: [page({ items: full }), page({ offset: 20 })] });
  assert.equal(btn(container, 'Trang trước').disabled, true);
  btn(container, 'Trang sau').click();
  await flush();
  assert.equal(calls.at(-1), `GET /api/disputes/${DISPUTE}/evidence?limit=20&offset=20`);
  assert.equal(btn(container, 'Trang trước').disabled, false);
});

test('list failure shows the mapped message and retry reloads', async () => {
  const { container } = await mount({ responses: [coded('NOT_FOUND', { status: 404 }), page()] });
  assert.match(container.textContent, /không có quyền xem/);
  btn(container, 'Tải lại').click();
  await flush();
  assert.match(container.textContent, /Ảnh 1/);
});

test('cleanup revokes shown thumbnails and late responses after unmount draw nothing', async () => {
  let release;
  const late = new Promise((resolve) => { release = resolve; });
  const { container, created, revoked, cleanup } = await mount({ responses: [page()], binaries: [blob(), late] });
  btn(container, 'Xem ảnh thu nhỏ').click();
  await flush();
  btn(container, 'Xem ảnh thu nhỏ').click();
  cleanup();
  release(blob());
  await flush();
  assert.equal(created.length, 1, 'no url created after cleanup');
  assert.ok(revoked.includes('blob:t/0'));
  assert.equal(find(container, 'IMG'), undefined, 'late response drew nothing after cleanup');
  assert.equal(created.length, 1);
});

test('a failed list read after an upload never claims the list was reloaded', async () => {
  const { container, announced } = await mount({
    responses: [page({ items: [] }), coded('NETWORK', { uncertain: true })],
    uploads: [{ data: { evidence: { id: EV } }, status: 201 }],
  });
  pick(container, jpeg());
  submit(container);
  await flush();
  assert.deepEqual(announced, []);
  assert.doesNotMatch(container.textContent, /Danh sách đã tải lại/);
  assert.match(container.textContent, /Chưa xác nhận được thao tác/);
});

test('inactive route renders nothing and makes no request', async () => {
  const { container, calls, cleanup } = await mount({ active: false, responses: [page()] });
  assert.equal(calls.length, 0);
  assert.equal(container.children.length, 0);
  assert.equal(typeof cleanup, 'function');
});

test('failed verification keeps upload blocked until a successful reload',async()=>{
 const {container}=await mount({responses:[page({items:[]}),coded('NETWORK',{uncertain:true}),page({items:[]})],uploads:[coded('TIMEOUT',{uncertain:true})]});
 pick(container,jpeg());submit(container);await flush();
 assert.equal(submitButton(container).disabled,true);
 btn(container,'Tải lại').click();await flush();
 assert.equal(submitButton(container).disabled,false);
});
