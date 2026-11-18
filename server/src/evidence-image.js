import { Buffer } from 'node:buffer';
import { crc32 } from 'node:zlib';

// ponytail: header and chunk-structure validation only. No IDAT inflate, no pixel decode,
// no palette entry or ancillary content checks. Ceiling: a file with valid headers but corrupt
// compressed data passes. Upgrade: decode under a byte budget in an isolated worker when needed.

export class EvidenceImageError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.name = 'EvidenceImageError';
    this.status = status;
    this.code = code;
  }
}

const MAX_BYTES = 5242880;
const MAX_SIDE = 4096;
const MAX_PIXELS = 16777216;
const invalid = (message) => new EvidenceImageError(400, 'INVALID_IMAGE', message);
const tooLarge = (message) => new EvidenceImageError(413, 'PAYLOAD_TOO_LARGE', message); // byte cap only

export function inspectEvidenceImage(bytes, contentType) {
  if (contentType !== 'image/png' && contentType !== 'image/jpeg') {
    throw new EvidenceImageError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only image/png and image/jpeg evidence is accepted');
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw invalid('Evidence image must be a non-empty Buffer');
  if (bytes.length > MAX_BYTES) throw tooLarge('Evidence image exceeds 5 MiB');
  return contentType === 'image/png' ? parsePng(bytes) : parseJpeg(bytes);
}

function assertDimensions(width, height) {
  if (width === 0 || height === 0) throw invalid('Zero image dimension');
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw invalid('Image dimensions exceed limit');
  return { width, height };
}

// PNG: walk chunks with bounded lengths and CRC-32 checks. Requires IHDR first, one contiguous IDAT run, IEND last.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BIT_DEPTHS = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);
const PNG_KNOWN_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

function parsePng(b) {
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) throw invalid('PNG signature missing');
  let pos = 8;
  let header = null;
  let palette = false;
  let idat = 0; // 0 none, 1 in contiguous IDAT run, 2 run ended
  const zlibHead = [];
  let iend = false;
  while (pos < b.length) {
    if (iend) throw invalid('Data after PNG IEND');
    if (pos + 12 > b.length) throw invalid('Truncated PNG chunk header');
    const length = b.readUInt32BE(pos);
    const typeStart = pos + 4;
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > b.length) throw invalid('PNG chunk exceeds file');
    const type = b.toString('latin1', typeStart, typeStart + 4);
    if (!/^[A-Za-z]{4}$/.test(type) || (type.charCodeAt(2) & 0x20) !== 0) throw invalid('Invalid PNG chunk type');
    if (crc32(b.subarray(typeStart, dataEnd)) !== b.readUInt32BE(dataEnd)) throw invalid('PNG chunk CRC mismatch');
    if ((type.charCodeAt(0) & 0x20) === 0 && !PNG_KNOWN_CRITICAL.has(type)) throw invalid('Unknown critical PNG chunk');

    if (!header) {
      if (type !== 'IHDR' || length !== 13) throw invalid('PNG must start with a 13-byte IHDR');
      header = parseIhdr(b, dataStart);
    } else if (type === 'IHDR') {
      throw invalid('Duplicate PNG IHDR');
    }

    if (idat === 1 && type !== 'IDAT') idat = 2;
    if (type === 'PLTE') {
      if (palette || idat > 0 || header.colorType === 0 || header.colorType === 4) throw invalid('Unexpected PNG PLTE');
      if (length === 0 || length > 768 || length % 3 !== 0) throw invalid('Invalid PNG palette length');
      palette = true;
    } else if (type === 'IDAT') {
      if (idat === 2) throw invalid('PNG IDAT chunks must be contiguous');
      if (header.colorType === 3 && !palette) throw invalid('Indexed PNG requires PLTE before IDAT');
      for (let i = dataStart; i < dataEnd && zlibHead.length < 2; i++) zlibHead.push(b[i]);
      idat = 1;
    } else if (type === 'IEND') {
      if (length !== 0) throw invalid('PNG IEND must be empty');
      if (idat === 0) throw invalid('PNG IEND before IDAT');
      iend = true;
    }
    pos = dataEnd + 4;
  }
  if (!iend) throw invalid('PNG IEND missing or file truncated');
  if (zlibHead.length < 2 || !zlibHeaderOk(zlibHead[0], zlibHead[1])) throw invalid('Invalid zlib header in PNG IDAT');
  return { width: header.width, height: header.height };
}

function parseIhdr(b, at) {
  const width = b.readUInt32BE(at);
  const height = b.readUInt32BE(at + 4);
  const bitDepth = b[at + 8];
  const colorType = b[at + 9];
  const compression = b[at + 10];
  const filter = b[at + 11];
  const interlace = b[at + 12];
  if (!PNG_BIT_DEPTHS.get(colorType)?.includes(bitDepth)) throw invalid('Invalid PNG bit depth or colour type');
  if (compression !== 0 || filter !== 0 || interlace > 1) throw invalid('Invalid PNG compression, filter or interlace method');
  return { colorType, ...assertDimensions(width, height) };
}

function zlibHeaderOk(cmf, flg) {
  return (cmf & 0x0f) === 8 && (cmf >> 4) <= 7 && (flg & 0x20) === 0 && (cmf * 256 + flg) % 31 === 0;
}

// JPEG: walk marker segments by length. Supports baseline (C0) and progressive (C2) SOF, 8-bit precision.
// Scan data is skipped to the next real marker, honouring byte stuffing and RST markers. Final EOI must be the last byte.
const JPEG_SUPPORTED_SOF = new Set([0xc0, 0xc2]);

function isSofMarker(m) {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

function parseJpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw invalid('JPEG SOI missing');
  let pos = 2;
  let size = null;
  let scans = 0;
  for (;;) {
    if (pos >= b.length || b[pos] !== 0xff) throw invalid('Malformed JPEG marker');
    while (pos + 2 < b.length && b[pos + 1] === 0xff) pos++; // fill bytes
    if (pos + 1 >= b.length) throw invalid('Truncated JPEG marker');
    const marker = b[pos + 1];
    if (marker === 0xd9) {
      if (pos + 2 !== b.length) throw invalid('Data after JPEG EOI');
      if (!size || scans === 0) throw invalid('JPEG SOF or SOS missing');
      return size;
    }
    if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw invalid('Unexpected JPEG standalone marker');
    }
    if (pos + 4 > b.length) throw invalid('Truncated JPEG segment');
    const length = b.readUInt16BE(pos + 2);
    if (length < 2 || pos + 2 + length > b.length) throw invalid('Invalid JPEG segment length');
    const payload = b.subarray(pos + 4, pos + 2 + length);
    pos += 2 + length;
    if (isSofMarker(marker)) {
      if (size) throw invalid('Multiple JPEG SOF markers');
      if (!JPEG_SUPPORTED_SOF.has(marker)) throw invalid('Unsupported JPEG frame type');
      size = parseSof(payload);
    } else if (marker === 0xda) {
      if (!size) throw invalid('JPEG SOS before SOF');
      if (payload.length < 1 || payload[0] < 1 || payload[0] > 4 || payload.length !== 4 + 2 * payload[0]) {
        throw invalid('Invalid JPEG SOS payload');
      }
      scans++;
      pos = scanEnd(b, pos);
    }
  }
}

function parseSof(p) {
  if (p.length < 6) throw invalid('Truncated JPEG SOF');
  const precision = p[0];
  const height = p.readUInt16BE(1);
  const width = p.readUInt16BE(3);
  const components = p[5];
  if (precision !== 8) throw invalid('Unsupported JPEG precision');
  if (components < 1 || components > 4 || p.length !== 6 + 3 * components) throw invalid('Invalid JPEG component count');
  for (let i = 0; i < components; i++) {
    const sampling = p[6 + 3 * i + 1];
    const h = sampling >> 4;
    const v = sampling & 0x0f;
    if (h < 1 || h > 4 || v < 1 || v > 4) throw invalid('Invalid JPEG sampling factor');
  }
  return assertDimensions(width, height);
}

function scanEnd(b, pos) {
  for (let i = pos; i + 1 < b.length; i++) {
    if (b[i] !== 0xff) continue;
    const next = b[i + 1];
    if (next === 0xff) continue; // fill byte: re-examine from the second FF
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
      i++; // stuffed byte or RST inside scan
      continue;
    }
    return i;
  }
  throw invalid('JPEG scan not terminated');
}
