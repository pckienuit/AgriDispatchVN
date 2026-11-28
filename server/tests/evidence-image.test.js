import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { EvidenceImageError, inspectEvidenceImage } from '../src/evidence-image.js';

// JPEG fixtures: solid-colour synthetic images encoded by Pillow (libjpeg). Header-level checks only.
const JPEG_BASELINE_3X2 = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlKKKK+XPjT//Z', 'base64');
const JPEG_PROGRESSIVE_4X4 = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAL/xAAVAQEBAAAAAAAAAAAAAAAAAAAFBv/aAAwDAQACEAMQAAABoTDn/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAD/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64');
const JPEG_EXIF_2X2 = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4QAwRXhpZgAATU0AKgAAAAgAAQEPAAIAAAAOAAAAGgAAAABTeW50aGV0aWNNYWtlAP/bAEMABgQFBgUEBgYFBgcHBggKEAoKCQkKFA4PDBAXFBgYFxQWFhodJR8aGyMcFhYgLCAjJicpKikZHy0wLSgwJSgpKP/bAEMBBwcHCggKEwoKEygaFhooKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKP/AABEIAAIAAgMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APleiiimI//Z', 'base64');

const MAX_BYTES = 5242880;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

function chunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function ihdr({ width = 3, height = 2, bitDepth = 8, colorType = 2, compression = 0, filter = 0, interlace = 0 } = {}) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data.set([bitDepth, colorType, compression, filter, interlace], 8);
  return data;
}

function png({ header = {}, chunks, idatData } = {}) {
  const options = { width: 3, height: 2, colorType: 2, ...header };
  const scanBytes = Math.max(0, options.height) * (1 + options.width * (CHANNELS[options.colorType] ?? 1));
  const body = chunks ?? [
    chunk('IHDR', ihdr(options)),
    chunk('IDAT', idatData ?? deflateSync(Buffer.alloc(scanBytes))),
    chunk('IEND'),
  ];
  return Buffer.concat([PNG_SIGNATURE, ...body]);
}

function segment(marker, payload = Buffer.alloc(0)) {
  const out = Buffer.alloc(4 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  out.writeUInt16BE(payload.length + 2, 2);
  payload.copy(out, 4);
  return out;
}

function frame(marker, { width = 2, height = 2, components = 1, precision = 8, sampling = 0x11 } = {}) {
  const payload = Buffer.alloc(6 + 3 * components);
  payload[0] = precision;
  payload.writeUInt16BE(height, 1);
  payload.writeUInt16BE(width, 3);
  payload[5] = components;
  for (let i = 0; i < components; i++) payload.set([i + 1, sampling, 0], 6 + 3 * i);
  return segment(marker, payload);
}

const SOS = segment(0xda, Buffer.from([1, 1, 0x00, 0x00, 0x3f, 0x00]));

function jpegWith(frameSegment, scan = Buffer.from([0x7f])) {
  return Buffer.concat([SOI, frameSegment, SOS, scan, EOI]);
}

// Stuffed 0xFF00 and RST0 inside scan data; header-only check must skip them safely.
const JPEG_SYNTHETIC_5X7 = jpegWith(frame(0xc0, { width: 5, height: 7 }), Buffer.from([0x12, 0xff, 0x00, 0xff, 0xd0, 0x34]));

function assertRejects(bytes, contentType, status = 400, code = 'INVALID_IMAGE') {
  assert.throws(
    () => inspectEvidenceImage(bytes, contentType),
    (err) => err instanceof EvidenceImageError && err.status === status && err.code === code,
  );
}

test('PNG: valid synthetic header returns dimensions', () => {
  assert.deepEqual(inspectEvidenceImage(png(), 'image/png'), { width: 3, height: 2 });
});

test('PNG: interlace method 1 is a valid header', () => {
  const bytes = png({ chunks: [chunk('IHDR', ihdr({ interlace: 1 })), chunk('IDAT', deflateSync(Buffer.alloc(20))), chunk('IEND')] });
  assert.deepEqual(inspectEvidenceImage(bytes, 'image/png'), { width: 3, height: 2 });
});

test('PNG: rejects bad signature', () => {
  const bytes = png();
  bytes[1] = 0x00;
  assertRejects(bytes, 'image/png');
});

test('PNG: rejects IHDR CRC mismatch', () => {
  const bytes = png();
  bytes[23] ^= 0x01; // IHDR height low byte, CRC unchanged
  assertRejects(bytes, 'image/png');
});

test('PNG: rejects IHDR whose length is not 13', () => {
  const bytes = png({ chunks: [chunk('IHDR', Buffer.alloc(14)), chunk('IDAT', deflateSync(Buffer.alloc(8))), chunk('IEND')] });
  assertRejects(bytes, 'image/png');
});

test('PNG: rejects invalid compression, filter and interlace methods', () => {
  for (const header of [{ compression: 1 }, { filter: 1 }, { interlace: 2 }]) {
    assertRejects(png({ header }), 'image/png');
  }
});

test('PNG: rejects bit depth that does not fit the colour type', () => {
  assertRejects(png({ header: { colorType: 2, bitDepth: 4 } }), 'image/png');
  assertRejects(png({ header: { colorType: 7 } }), 'image/png');
});

test('PNG: indexed colour requires PLTE before IDAT', () => {
  const withoutPalette = png({ header: { colorType: 3 } });
  assertRejects(withoutPalette, 'image/png');
  const withPalette = png({
    chunks: [chunk('IHDR', ihdr({ colorType: 3 })), chunk('PLTE', Buffer.from([0, 0, 0])), chunk('IDAT', deflateSync(Buffer.alloc(8))), chunk('IEND')],
  });
  assert.deepEqual(inspectEvidenceImage(withPalette, 'image/png'), { width: 3, height: 2 });
});

test('PNG: rejects truncated file, bad chunk length and missing IEND', () => {
  assertRejects(png().subarray(0, 40), 'image/png');
  const bytes = png();
  assertRejects(bytes.subarray(0, bytes.length - 12), 'image/png');
  const oversizedIdat = png();
  oversizedIdat.writeUInt32BE(0x7fffffff, 33); // IDAT length field after 8-byte signature and 25-byte IHDR
  assertRejects(oversizedIdat, 'image/png');
});

test('PNG: rejects missing IDAT, split IDAT and trailing data after IEND', () => {
  assertRejects(png({ chunks: [chunk('IHDR', ihdr()), chunk('IEND')] }), 'image/png');
  assertRejects(png({ chunks: [chunk('IHDR', ihdr()), chunk('IDAT', deflateSync(Buffer.alloc(8))), chunk('tEXt', Buffer.from('c\0x')), chunk('IDAT', deflateSync(Buffer.alloc(8))), chunk('IEND')] }), 'image/png');
  assertRejects(Buffer.concat([png(), Buffer.from('junk')]), 'image/png');
  assertRejects(png({ chunks: [chunk('IHDR', ihdr()), chunk('IDAT', deflateSync(Buffer.alloc(8))), chunk('IEND', Buffer.from([0]))] }), 'image/png');
});

test('PNG: rejects unknown critical chunk and invalid chunk type, accepts private ancillary', () => {
  const idat = chunk('IDAT', deflateSync(Buffer.alloc(8)));
  assertRejects(png({ chunks: [chunk('IHDR', ihdr()), chunk('ZzZz'), idat, chunk('IEND')] }), 'image/png');
  assertRejects(png({ chunks: [chunk('IHDR', ihdr()), chunk('IDA1'), idat, chunk('IEND')] }), 'image/png');
  assert.deepEqual(inspectEvidenceImage(png({ chunks: [chunk('IHDR', ihdr()), chunk('prVt', Buffer.from('x')), idat, chunk('IEND')] }), 'image/png'), { width: 3, height: 2 });
});

test('PNG: rejects zero width and zero height', () => {
  assertRejects(png({ header: { width: 0 } }), 'image/png');
  assertRejects(png({ header: { height: 0 } }), 'image/png');
});

test('PNG: dimension and pixel limits reject without decoding', () => {
  const tiny = deflateSync(Buffer.alloc(1));
  assertRejects(png({ header: { width: 4097, height: 1 }, idatData: tiny }), 'image/png');
  assertRejects(png({ header: { width: 4096, height: 4097 }, idatData: tiny }), 'image/png');
  assert.deepEqual(inspectEvidenceImage(png({ header: { width: 4096, height: 4096 }, idatData: tiny }), 'image/png'), { width: 4096, height: 4096 });
});

test('PNG: accepts exactly 5242880 bytes and rejects one byte more', () => {
  const withText = (extra) => png({
    chunks: [chunk('IHDR', ihdr()), chunk('IDAT', deflateSync(Buffer.alloc(8))), chunk('tEXt', Buffer.concat([Buffer.from('c\0'), Buffer.alloc(extra, 0x61)])), chunk('IEND')],
  });
  const base = withText(0);
  const exact = withText(MAX_BYTES - base.length);
  assert.equal(exact.length, MAX_BYTES);
  assert.deepEqual(inspectEvidenceImage(exact, 'image/png'), { width: 3, height: 2 });
  assertRejects(Buffer.concat([exact, Buffer.alloc(1)]), 'image/png', 413, 'PAYLOAD_TOO_LARGE');
});

test('JPEG: baseline fixture returns dimensions', () => {
  assert.deepEqual(inspectEvidenceImage(JPEG_BASELINE_3X2, 'image/jpeg'), { width: 3, height: 2 });
});

test('JPEG: progressive fixture returns dimensions', () => {
  assert.deepEqual(inspectEvidenceImage(JPEG_PROGRESSIVE_4X4, 'image/jpeg'), { width: 4, height: 4 });
});

test('JPEG: EXIF fixture validates and bytes stay unchanged', () => {
  const before = Buffer.from(JPEG_EXIF_2X2);
  assert.deepEqual(inspectEvidenceImage(JPEG_EXIF_2X2, 'image/jpeg'), { width: 2, height: 2 });
  assert.deepEqual(JPEG_EXIF_2X2, before);
  assert.ok(JPEG_EXIF_2X2.includes(Buffer.from('SyntheticMake')));
});

test('JPEG: stuffed and RST bytes inside scan are accepted', () => {
  assert.deepEqual(inspectEvidenceImage(JPEG_SYNTHETIC_5X7, 'image/jpeg'), { width: 5, height: 7 });
});

test('JPEG: rejects missing final EOI and trailing bytes after EOI', () => {
  assertRejects(JPEG_BASELINE_3X2.subarray(0, JPEG_BASELINE_3X2.length - 2), 'image/jpeg');
  assertRejects(Buffer.concat([JPEG_BASELINE_3X2, Buffer.from('junk')]), 'image/jpeg');
  assertRejects(Buffer.concat([JPEG_SYNTHETIC_5X7, EOI]), 'image/jpeg');
});

test('JPEG: rejects unterminated scan data', () => {
  assertRejects(Buffer.concat([SOI, frame(0xc0), SOS, Buffer.from([0x12])]), 'image/jpeg');
});

test('JPEG: rejects missing SOF or SOS', () => {
  assertRejects(Buffer.concat([SOI, SOS, Buffer.from([0x00]), EOI]), 'image/jpeg');
  assertRejects(Buffer.concat([SOI, frame(0xc0), EOI]), 'image/jpeg');
});

test('JPEG: rejects zero width or height', () => {
  assertRejects(jpegWith(frame(0xc0, { height: 0 })), 'image/jpeg');
  assertRejects(jpegWith(frame(0xc0, { width: 0 })), 'image/jpeg');
});

test('JPEG: rejects invalid segment lengths', () => {
  const badLow = Buffer.concat([SOI, Buffer.from([0xff, 0xe0, 0x00, 0x01]), frame(0xc0), SOS, Buffer.from([0x7f]), EOI]);
  assertRejects(badLow, 'image/jpeg');
  const badHigh = Buffer.concat([SOI, Buffer.from([0xff, 0xe0, 0xff, 0xff]), frame(0xc0), SOS, Buffer.from([0x7f]), EOI]);
  assertRejects(badHigh, 'image/jpeg');
});

test('JPEG: rejects invalid SOF payload', () => {
  assertRejects(jpegWith(frame(0xc0, { components: 0 })), 'image/jpeg');
  assertRejects(jpegWith(frame(0xc0, { components: 5 })), 'image/jpeg');
  assertRejects(jpegWith(frame(0xc0, { sampling: 0x01 })), 'image/jpeg');
  assertRejects(jpegWith(frame(0xc0, { precision: 12 })), 'image/jpeg');
});

test('JPEG: rejects unsupported SOF process and repeated SOF', () => {
  assertRejects(jpegWith(frame(0xc3)), 'image/jpeg');
  assertRejects(jpegWith(frame(0xc1)), 'image/jpeg'); // extended sequential: not in supported set
  assertRejects(Buffer.concat([SOI, frame(0xc0), frame(0xc2), SOS, Buffer.from([0x7f]), EOI]), 'image/jpeg');
});

test('JPEG: rejects SOS before SOF even when a later SOF follows', () => {
  assertRejects(Buffer.concat([SOI, SOS, Buffer.from([0x7f]), frame(0xc0), SOS, Buffer.from([0x7f]), EOI]), 'image/jpeg');
});

test('JPEG: rejects standalone RST marker outside scan', () => {
  assertRejects(Buffer.concat([SOI, Buffer.from([0xff, 0xd0]), frame(0xc0), SOS, Buffer.from([0x7f]), EOI]), 'image/jpeg');
});

test('JPEG: dimension limits reject before returning', () => {
  assertRejects(jpegWith(frame(0xc0, { width: 4097, height: 1 })), 'image/jpeg');
  assertRejects(jpegWith(frame(0xc0, { width: 4096, height: 4097 })), 'image/jpeg');
  assert.deepEqual(inspectEvidenceImage(jpegWith(frame(0xc0, { width: 4096, height: 4096 })), 'image/jpeg'), { width: 4096, height: 4096 });
});

test('content type must be exact and match the bytes', () => {
  for (const type of ['image/svg+xml', 'image/gif', 'text/html', 'image/jpg', undefined]) {
    assertRejects(png(), type, 415, 'UNSUPPORTED_MEDIA_TYPE');
  }
  assertRejects(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'), 'image/gif', 415, 'UNSUPPORTED_MEDIA_TYPE');
  assertRejects(png(), 'image/jpeg');
  assertRejects(JPEG_BASELINE_3X2, 'image/png');
  assertRejects(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'), 'image/png');
  assertRejects(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'), 'image/jpeg');
  assertRejects(Buffer.from('<!doctype html><html></html>'), 'image/jpeg');
});

test('input must be a non-empty Buffer and oversize is checked before parsing', () => {
  assertRejects(Buffer.alloc(0), 'image/png');
  assertRejects('not bytes', 'image/png');
  assertRejects(new Uint8Array(png()), 'image/png');
  assertRejects(Buffer.alloc(MAX_BYTES + 1), 'image/png', 413, 'PAYLOAD_TOO_LARGE');
});

test('EvidenceImageError carries HTTP status and stable code', () => {
  let caught;
  try {
    inspectEvidenceImage(Buffer.alloc(1), 'image/gif');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof EvidenceImageError);
  assert.ok(caught instanceof Error);
  assert.equal(caught.status, 415);
  assert.equal(caught.code, 'UNSUPPORTED_MEDIA_TYPE');
});
