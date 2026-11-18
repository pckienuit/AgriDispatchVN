'use strict';
/* global __dirname */
const { Buffer } = require('node:buffer');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sharp = require('sharp');

// ponytail: decode runs in-process under sharp's pixel limit and a 5 s libvips timeout, not in an
// isolated worker. Ceiling: a single bad image can still hold the event loop briefly. Upgrade: move
// makeThumbnail into a worker_threads pool when concurrent load is measured.

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 16777216;
const TIMEOUT_SECONDS = 5;
const OUT_SIDE = 320;
const OUT_QUALITY = 80;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOI = Buffer.from([0xff, 0xd8]);

// Structure validator shared with the API path; the server module is ESM, so load it lazily from CJS.
let inspectPromise;
const loadInspect = () => {
  inspectPromise ??= import(pathToFileURL(path.join(__dirname, '../../server/src/evidence-image.js')).href)
    .then((m) => m.inspectEvidenceImage);
  return inspectPromise;
};

const fail = (code) => Object.assign(new Error(code), { code });

async function makeThumbnail(bytes, key) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) throw fail('INVALID_IMAGE');
  if (typeof key !== 'string' || !KEY.test(key)) throw fail('INVALID_OBJECT_KEY');
  if (createHash('sha256').update(bytes).digest('hex') !== key.slice(-64)) throw fail('INVALID_OBJECT_KEY');

  let type;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) type = 'image/png';
  else if (bytes.length >= 2 && bytes.subarray(0, 2).equals(JPEG_SOI)) type = 'image/jpeg';
  else throw fail('INVALID_IMAGE');

  try {
    await (await loadInspect())(bytes, type);
  } catch {
    throw fail('INVALID_IMAGE');
  }

  try {
    const { data, info } = await sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_PIXELS })
      .timeout({ seconds: TIMEOUT_SECONDS })
      .rotate()
      .resize({ width: OUT_SIDE, height: OUT_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: OUT_QUALITY })
      .toBuffer({ resolveWithObject: true });
    if (info.format !== 'jpeg') throw new Error('unexpected output format');
    return { key: `${key}.jpg`, bytes: data, width: info.width, height: info.height };
  } catch {
    throw fail('INVALID_IMAGE');
  }
}

module.exports = { makeThumbnail };
