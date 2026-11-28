'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { createHash, randomUUID } = require('node:crypto');
const { crc32 } = require('node:zlib');
const sharp = require('sharp');
const { makeThumbnail } = require('./processor.cjs');

const MIB = 1024 * 1024;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const keyFor = (bytes) => `${randomUUID()}/${randomUUID()}/${sha(bytes)}`;
const solid = (width, height, format = 'png') => {
  const img = sharp({ create: { width, height, channels: 3, background: { r: 30, g: 140, b: 60 } } });
  return format === 'jpeg' ? img.jpeg().toBuffer() : img.png().toBuffer();
};

// Build a raw APP1/Exif segment carrying only an Orientation tag (synthetic fixture).
function exifOrientationSegment(orientation) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('MM', 0);
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = 0xe1;
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

// Insert a PNG chunk with a valid CRC before IEND.
function pngWithChunk(png, type, data) {
  const iend = png.length - 12;
  const typeBuf = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([png.subarray(0, iend), len, typeBuf, data, crc, png.subarray(iend)]);
}

// Replace the data of a chunk and recompute its CRC, so structure checks pass while content is wrong.
function pngWithPatchedChunk(png, type, patch) {
  let pos = 8;
  while (pos < png.length) {
    const length = png.readUInt32BE(pos);
    const t = png.toString('latin1', pos + 4, pos + 8);
    const data = Buffer.from(png.subarray(pos + 8, pos + 8 + length));
    if (t === type) {
      patch(data);
      const out = Buffer.from(png);
      data.copy(out, pos + 8);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])));
      crc.copy(out, pos + 8 + length);
      return out;
    }
    pos += 12 + length;
  }
  throw new Error(`chunk ${type} not found`);
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code);
    assert.equal(err.message, code, 'error message must be the fixed code, no raw detail');
    return true;
  });
}

test('PNG input yields bounded JPEG thumbnail with derived key', async () => {
  const bytes = await solid(640, 480);
  const key = keyFor(bytes);
  const out = await makeThumbnail(bytes, key);
  assert.equal(out.key, `${key}.jpg`);
  assert.equal(out.bytes[0], 0xff);
  assert.equal(out.bytes[1], 0xd8);
  assert.equal(out.width, 320);
  assert.equal(out.height, 240);
  const meta = await sharp(out.bytes).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 320);
  assert.equal(meta.height, 240);
});

test('progressive JPEG input is decoded and thumbnailed', async () => {
  const bytes = await sharp({ create: { width: 500, height: 400, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .jpeg({ progressive: true })
    .toBuffer();
  assert.equal((await sharp(bytes).metadata()).isProgressive, true);
  const out = await makeThumbnail(bytes, keyFor(bytes));
  assert.equal(out.width, 320);
  assert.equal(out.height, 256);
});

test('small image is not enlarged', async () => {
  const bytes = await solid(100, 50);
  const out = await makeThumbnail(bytes, keyFor(bytes));
  assert.equal(out.width, 100);
  assert.equal(out.height, 50);
});

test('EXIF orientation 6 rotates output to portrait', async () => {
  const base = await solid(600, 300, 'jpeg');
  const bytes = Buffer.concat([base.subarray(0, 2), exifOrientationSegment(6), base.subarray(2)]);
  assert.equal((await sharp(bytes).metadata()).orientation, 6);
  const out = await makeThumbnail(bytes, keyFor(bytes));
  assert.equal(out.width, 160);
  assert.equal(out.height, 320);
});

test('output strips EXIF and GPS metadata from input', async () => {
  const bytes = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .withExif({ IFD0: { Make: 'SyntheticCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '10/1 0/1 0/1' } })
    .jpeg()
    .toBuffer();
  assert.ok((await sharp(bytes).metadata()).exif, 'precondition: input carries EXIF');
  const out = await makeThumbnail(bytes, keyFor(bytes));
  assert.equal((await sharp(out.bytes).metadata()).exif, undefined);
  assert.equal(out.bytes.includes(Buffer.from('Exif\0\0', 'latin1')), false);
  assert.equal(out.bytes.includes(Buffer.from('SyntheticCam', 'latin1')), false);
});

test('repeated runs on same bytes give identical key and output bytes', async () => {
  const bytes = await solid(777, 555, 'jpeg');
  const key = keyFor(bytes);
  const a = await makeThumbnail(bytes, key);
  const b = await makeThumbnail(bytes, key);
  assert.equal(a.key, b.key);
  assert.equal(sha(a.bytes), sha(b.bytes));
});

test('key must match ^uuid/uuid/64hex and bind the input bytes', async () => {
  const bytes = await solid(40, 40);
  const good = keyFor(bytes);
  const bad = [
    'not-a-key',
    `${randomUUID()}/${randomUUID()}/${'a'.repeat(63)}`,
    `${randomUUID()}/${randomUUID()}/${'A'.repeat(64)}`,
    `../${randomUUID()}/${sha(bytes)}`,
    `${randomUUID()}/${randomUUID()}/${sha(bytes)}/extra`,
    `${randomUUID()}/${randomUUID()}/${'0'.repeat(64)}`,
    `${randomUUID().toUpperCase()}/${randomUUID()}/${sha(bytes)}`,
    42,
  ];
  for (const key of bad) await expectCode(makeThumbnail(bytes, key), 'INVALID_OBJECT_KEY');
  const out = await makeThumbnail(bytes, good);
  assert.equal(out.key, `${good}.jpg`);
});

test('unsupported formats are rejected with INVALID_IMAGE', async () => {
  const gif = Buffer.from('GIF89a' + '\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff,\x00\x00\x00\x00\x01\x00\x01\x00\x00;', 'latin1');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
  for (const bytes of [gif, webp, Buffer.from('hello world')]) {
    await expectCode(makeThumbnail(bytes, keyFor(bytes)), 'INVALID_IMAGE');
  }
});

test('non-Buffer and empty input are rejected with INVALID_IMAGE', async () => {
  await expectCode(makeThumbnail('not bytes', keyFor(Buffer.from('x'))), 'INVALID_IMAGE');
  await expectCode(makeThumbnail(Buffer.alloc(0), keyFor(Buffer.alloc(0))), 'INVALID_IMAGE');
});

test('5 MiB cap is inclusive; one byte over is rejected before decode', async () => {
  const base = await solid(64, 64);
  // tEXt chunk adds 12 bytes overhead + data; pad payload so total file is exactly 5 MiB.
  const payload = 5 * MIB - base.length - 12 - 8;
  const exact = pngWithChunk(base, 'tEXt', Buffer.concat([Buffer.from('Comment\0', 'latin1'), Buffer.alloc(payload, 0x61)]));
  assert.equal(exact.length, 5 * MIB, 'precondition: fixture is exactly 5 MiB');
  const out = await makeThumbnail(exact, keyFor(exact));
  assert.equal(out.width, 64);

  const over = Buffer.concat([exact, Buffer.alloc(1)]);
  await expectCode(makeThumbnail(over, keyFor(over)), 'INVALID_IMAGE');
});

test('dimension caps: 4096 side and 16777216 pixels are inclusive', async () => {
  const exactPixels = await solid(4096, 4096);
  const out = await makeThumbnail(exactPixels, keyFor(exactPixels));
  assert.equal(out.width, 320);
  assert.equal(out.height, 320);

  const wide = await solid(4097, 1);
  await expectCode(makeThumbnail(wide, keyFor(wide)), 'INVALID_IMAGE');
  const over = await solid(4096, 4097);
  await expectCode(makeThumbnail(over, keyFor(over)), 'INVALID_IMAGE');
});

test('malformed PNG with bad filter byte is rejected', async () => {
  const base = await solid(32, 32);
  const bad = pngWithPatchedChunk(base, 'IHDR', (d) => { d[11] = 1; });
  await expectCode(makeThumbnail(bad, keyFor(bad)), 'INVALID_IMAGE');
});

test('PNG with corrupt IHDR CRC is rejected', async () => {
  const base = await solid(32, 32);
  const bad = Buffer.from(base);
  bad[8 + 8 + 13] ^= 0xff; // first byte of IHDR CRC (sig 8 + len 4 + type 4 + data 13)
  await expectCode(makeThumbnail(bad, keyFor(bad)), 'INVALID_IMAGE');
});

test('PNG with valid structure but corrupt zlib data fails decode', async () => {
  const base = await solid(64, 64);
  const bad = pngWithPatchedChunk(base, 'IDAT', (d) => {
    for (let i = 2; i < d.length - 4; i++) d[i] ^= 0x5a;
  });
  await expectCode(makeThumbnail(bad, keyFor(bad)), 'INVALID_IMAGE');
});

test('truncated JPEG entropy data with a forged EOI is rejected', async () => {
  const full = await solid(300, 300, 'jpeg');
  const cut = Buffer.concat([full.subarray(0, Math.floor(full.length / 2)), Buffer.from([0xff, 0xd9])]);
  await expectCode(makeThumbnail(cut, keyFor(cut)), 'INVALID_IMAGE');
});

test('error objects carry fixed code and no raw input detail', async () => {
  const bytes = Buffer.from('plain text secret-token-123');
  const key = keyFor(bytes);
  await assert.rejects(makeThumbnail(bytes, key), (err) => {
    assert.equal(err.code, 'INVALID_IMAGE');
    assert.equal(String(err.message).includes('secret'), false);
    assert.equal(String(err.message).includes(key), false);
    return true;
  });
});
