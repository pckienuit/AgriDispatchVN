import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import jsQR from 'jsqr';
import * as vietqr from '../src/vietqr-emvco.js';

const input = { bankBin: '970436', accountNumber: '001234567890', amountVnd: '345000', description: 'Cọc đợt 1! / DEP-01' };

function parseTlv(text) {
  const items = [];
  for (let i = 0; i < text.length;) {
    const tag = text.slice(i, i + 2);
    const end = i + 4 + Number(text.slice(i + 2, i + 4));
    assert.ok(end > i + 4 && end <= text.length);
    items.push([tag, text.slice(i + 4, end)]);
    i = end;
  }
  return items;
}

test('VietQR builds exact nested NAPAS TLV and CCITT-FALSE checksum', () => {
  assert.equal(vietqr.crc16CcittFalse('123456789'), '29B1');
  const payload = vietqr.buildVietqrPayload(input);
  const items = parseTlv(payload);
  assert.deepEqual(items, [
    ['00', '01'], ['01', '12'], ['38', '0010A0000007270126000697043601120012345678900208QRIBFTTA'],
    ['53', '704'], ['54', '345000'], ['58', 'VN'], ['62', '0815COC DOT 1 DEP01'], ['63', 'C070'],
  ]);
  assert.throws(() => vietqr.buildVietqrPayload({ ...input, amountVnd: '1.00' }), RangeError);
  assert.throws(() => vietqr.buildVietqrPayload({ ...input, accountNumber: '012\n' }), RangeError);
});

// Rasterize precisely the rendered SVG module path, not the encoder's internal matrix.
function decodeSvg(svg) {
  const [, dimension] = svg.match(/viewBox="0 0 (\d+) \1"/);
  const scale = 5;
  const width = Number(dimension) * scale;
  const rgba = new Uint8ClampedArray(width * width * 4).fill(255);
  const [, path] = svg.match(/<path d="([^"]+)"/);
  const modules = [...path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)];
  assert.equal(modules.map((match) => match[0]).join(''), path);
  for (const [, x, y] of modules) {
    assert.ok(Number(x) >= 4 && Number(x) < Number(dimension) - 4);
    assert.ok(Number(y) >= 4 && Number(y) < Number(dimension) - 4);
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const pixel = ((Number(y) * scale + dy) * width + Number(x) * scale + dx) * 4;
        rgba.fill(0, pixel, pixel + 3);
      }
    }
  }
  return jsQR(rgba, width, width, { inversionAttempts: 'dontInvert' });
}

test('independent scanner decodes every byte of generated SVG', () => {
  for (const fields of [input, { ...input, accountNumber: '00' + 'Ab'.repeat(16), amountVnd: '922337203685477581', description: 'Đ'.repeat(50) }]) {
    const payload = vietqr.buildVietqrPayload(fields);
    const decoded = decodeSvg(vietqr.renderQrSvg(payload));
    assert.ok(decoded, 'SVG must be scannable');
    assert.deepEqual(decoded.binaryData, [...Buffer.from(payload, 'ascii')]);
    assert.equal(decoded.data, payload);
    assert.deepEqual(decoded.chunks.map(({ type }) => type), ['byte']);
  }
});
