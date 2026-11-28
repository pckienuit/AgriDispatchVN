// Static and pure-function checks for the demo-v2 product UI in web/v2. Browser flows are covered by the system browser tests.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { NAV, ROLES, codeAllowedInRole, homeSlugFor, navFor, parseHash, url } from '../../web/v2/app/routes.js';
import { registry } from '../../web/v2/app/registry.js';
import { safeNext } from '../../web/v2/screens/common.js';

const root = new URL('../../web/v2/', import.meta.url);

async function jsFiles(dir = root) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor') continue;
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) out.push(...await jsFiles(child));
    else if (entry.name.endsWith('.js')) out.push(child);
  }
  return out;
}

test('parseHash follows the demo v2 route format and rejects unknown shapes', () => {
  assert.deepEqual(parseHash(''), { kind: 'home' });
  assert.deepEqual(parseHash('#/'), { kind: 'home' });
  assert.equal(parseHash('#/nong-dan').kind, 'role');
  const r = parseHash('#/nong-dan/f-07?id=ABC&id=second&tt=x');
  assert.equal(r.kind, 'screen');
  assert.equal(r.code, 'F-07');
  assert.equal(r.role.slug, 'nong-dan');
  assert.deepEqual(r.params, { id: 'ABC', tt: 'x' });
  assert.equal(parseHash('#/khong-co/F-01').kind, 'notfound');
  assert.equal(parseHash('#/nong-dan/F-1').kind, 'notfound');
  assert.equal(parseHash('#/nong-dan/F-01/extra').kind, 'notfound');
  assert.equal(parseHash('#/__proto__/F-01').kind, 'notfound');
  assert.deepEqual(parseHash('#/nong-dan/F-01?__proto__=x&Bad=1').params, {});
  assert.equal(parseHash(`#/nong-dan/F-01?id=${'x'.repeat(201)}`).params.id, undefined);
});

test('url builds hashes that parse back and drops empty params', () => {
  const hash = url('chu-may', 'P-02', { id: 'a b', empty: '', none: null });
  assert.equal(hash, '#/chu-may/P-02?id=a+b');
  assert.deepEqual(parseHash(hash).params, { id: 'a b' });
});

test('login return route preserves internal screen params and rejects unknown or external targets', () => {
  assert.equal(safeNext('/nong-dan/f-06?giong=OM+5451&__proto__=x', registry), '#/nong-dan/F-06?giong=OM+5451');
  for (const value of ['https://example.test/', '//nong-dan/F-06', '/nong-dan/A-01', '/htx/H-10', '/chung/C-01']) {
    assert.equal(safeNext(value, registry), null, value);
  }
});

test('role guards: screen letter must match role, account screens are shared', () => {
  assert.equal(codeAllowedInRole('F-01', 'nong-dan'), true);
  assert.equal(codeAllowedInRole('F-01', 'chu-may'), false);
  assert.equal(codeAllowedInRole('C-02', 'htx'), true);
  assert.equal(codeAllowedInRole('C-01', 'htx'), false);
  assert.equal(homeSlugFor({ roles: ['farmer', 'provider'] }), 'chu-may');
  assert.equal(homeSlugFor({ roles: ['farmer', 'admin'] }), 'quan-tri');
  assert.equal(homeSlugFor({ roles: [] }), null);
  assert.equal(homeSlugFor(null), null);
});

test('nav hides screens that are not built and marks child screens current', () => {
  const built = new Set(['F-01', 'F-07']);
  const nav = navFor('nong-dan', 'F-11', built);
  assert.deepEqual(nav.map((n) => n.code), ['F-01', 'F-07']);
  assert.equal(nav.find((n) => n.code === 'F-07').current, true);
  for (const role of ROLES) for (const [, , code] of NAV[role.slug]) assert.ok(codeAllowedInRole(code, role.slug), `${role.slug} ${code}`);
});

test('router registry includes all 54 reference screens (52 demo plus public C-05, C-06) with titles and renderers', async () => {
  const inventory = await readFile(new URL('../../docs/ui-demo-v2-screens.md', import.meta.url), 'utf8');
  const expected = [...inventory.matchAll(/^\| ([CFPOHA]-\d{2}) \|/gm)].map((match) => match[1]);
  assert.equal(expected.length, 54, '52 demo screens plus public C-05, C-06');
  assert.deepEqual([...registry.keys()].sort(), expected.sort());
  for (const [code, screen] of registry) {
    assert.equal(screen.code, code);
    assert.equal(typeof screen.title, 'string', code);
    assert.ok(screen.title.trim(), code);
    assert.equal(typeof screen.render, 'function', code);
  }
});

test('web/v2 code uses only vendored icons, no HTML parsing, no browser storage and no dashes in UI text', async () => {
  const css = await readFile(new URL('vendor/phosphor/style.css', root), 'utf8');
  const icons = new Set([...css.matchAll(/\.ph-([a-z-]+):before/g)].map((m) => m[1]));
  for (const file of await jsFiles()) {
    const src = await readFile(file, 'utf8');
    const name = file.pathname.split('/web/v2/')[1];
    for (const m of src.matchAll(/(?:ui\.icon\(|icon:\s*)'([a-z-]+)'/g)) assert.ok(icons.has(m[1]), `${name}: icon ${m[1]} is not in the vendored Phosphor subset`);
    assert.doesNotMatch(src, /\.innerHTML|insertAdjacentHTML|outerHTML\s*=|document\.write/, name);
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/, name);
    assert.doesNotMatch(src, /[\u2013\u2014]/, `${name} contains an en or em dash`);
  }
});
