import { Buffer } from 'node:buffer';

export const BANK_BIN = /^[0-9]{6}$/;
export const ACCOUNT_NUMBER = /^[A-Za-z0-9]{4,34}$/;
const AMOUNT = /^[1-9][0-9]{0,17}$/;

export function crc16CcittFalse(text) {
  let crc = 0xFFFF;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function vietqrDescription(text) {
  return text.normalize('NFD').replace(/[đĐ]/g, 'D').replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().replace(/ +/g, ' ').trim().slice(0, 25).trimEnd() || 'DAT COC';
}

const tlv = (tag, text) => `${tag}${String(Buffer.byteLength(text)).padStart(2, '0')}${text}`;

export function buildVietqrPayload({ bankBin, accountNumber, amountVnd, description }) {
  if (typeof bankBin !== 'string' || !BANK_BIN.test(bankBin) ||
      typeof accountNumber !== 'string' || !ACCOUNT_NUMBER.test(accountNumber) ||
      typeof amountVnd !== 'string' || !AMOUNT.test(amountVnd)) throw new RangeError('Invalid VietQR transfer details');
  const beneficiary = tlv('00', bankBin) + tlv('01', accountNumber);
  const account = tlv('00', 'A000000727') + tlv('01', beneficiary) + tlv('02', 'QRIBFTTA');
  const payload = '000201010212' + tlv('38', account) + '5303704' + tlv('54', amountVnd) + '5802VN'
    + tlv('62', tlv('08', vietqrDescription(description))) + '6304';
  return payload + crc16CcittFalse(payload);
}

// ISO/IEC 18004 byte mode, version 9-M (53 modules, 180 byte capacity).
// ponytail: fixed version fits the bounded VietQR contract. Add version selection only if encoding other data.
const SIZE = 53;
const BLOCK_SIZES = [36, 36, 36, 37, 37];
const ECC_SIZE = 22;
const DATA_SIZE = 182;
const bit = (n, i) => (n >>> i) & 1;

function gfMultiply(a, b) {
  let result = 0;
  for (; b; b >>>= 1) {
    if (b & 1) result ^= a;
    a = (a << 1) ^ ((a & 0x80) ? 0x11D : 0);
  }
  return result;
}

function eccGenerator() {
  const coefficients = new Uint8Array(ECC_SIZE);
  coefficients[ECC_SIZE - 1] = 1;
  for (let i = 0, root = 1; i < ECC_SIZE; i++, root = gfMultiply(root, 2)) {
    for (let j = 0; j < ECC_SIZE; j++) coefficients[j] = gfMultiply(coefficients[j], root) ^ (coefficients[j + 1] ?? 0);
  }
  return coefficients;
}

const generator = eccGenerator();
function reedSolomon(data) {
  const remainder = new Uint8Array(ECC_SIZE);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[ECC_SIZE - 1] = 0;
    for (let j = 0; j < ECC_SIZE; j++) remainder[j] ^= gfMultiply(generator[j], factor);
  }
  return remainder;
}

function qrCodewords(payload) {
  const bytes = Buffer.from(payload, 'utf8');
  if (bytes.length > DATA_SIZE - 2) throw new RangeError('VietQR payload exceeds QR capacity');
  // Byte-mode indicator (0100), 8-bit count, payload, 4-bit terminator, alternating pad codewords.
  const data = [0x40 | (bytes.length >> 4)];
  let carry = bytes.length & 15;
  for (const byte of bytes) {
    data.push((carry << 4) | (byte >> 4));
    carry = byte & 15;
  }
  data.push(carry << 4);
  for (let pad = 0xEC; data.length < DATA_SIZE; pad ^= 0xFD) data.push(pad);

  let offset = 0;
  const blocks = BLOCK_SIZES.map((length) => {
    const block = data.slice(offset, offset + length);
    offset += length;
    return block;
  });
  const ecc = blocks.map(reedSolomon);
  const interleave = (parts) => Array.from({ length: parts.at(-1).length }, (_, i) =>
    parts.flatMap((part) => i < part.length ? [part[i]] : [])).flat();
  return interleave(blocks).concat(interleave(ecc));
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

function drawFormat(matrix, mask) {
  let remainder = mask; // M format bits are 00.
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ (bit(remainder, 9) * 0x537);
  const format = ((mask << 10) | remainder) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const value = bit(format, i);
    if (i < 8) {
      matrix[i < 6 ? i : i + 1][8] = value;
      matrix[8][SIZE - 1 - i] = value;
    } else {
      matrix[8][i === 8 ? 7 : 14 - i] = value;
      matrix[SIZE - 15 + i][8] = value;
    }
  }
  matrix[SIZE - 8][8] = 1;
}

function qrMatrix(codewords) {
  const base = Array.from({ length: SIZE }, () => new Int8Array(SIZE).fill(-1));
  for (let i = 0; i < SIZE; i++) base[6][i] = base[i][6] = 1 - (i % 2);
  function target(cx, cy, radius, lightRings) {
    for (let y = Math.max(0, cy - radius); y <= Math.min(SIZE - 1, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(SIZE - 1, cx + radius); x++) {
        base[y][x] = Number(!lightRings.includes(Math.max(Math.abs(x - cx), Math.abs(y - cy))));
      }
    }
  }
  for (const [x, y] of [[3, 3], [SIZE - 4, 3], [3, SIZE - 4]]) target(x, y, 4, [2, 4]);
  for (const [x, y] of [[26, 6], [6, 26], [26, 26], [46, 26], [26, 46], [46, 46]]) target(x, y, 2, [1]);
  // Version 9 BCH bits (two copies); reserve format modules before placing data.
  for (let i = 0; i < 18; i++) {
    const a = SIZE - 11 + (i % 3), b = Math.floor(i / 3);
    base[b][a] = base[a][b] = bit(0x09A99, i);
  }
  drawFormat(base, 0);
  const positions = [];
  for (let right = SIZE - 1, up = true; right > 0; right -= 2, up = !up) {
    if (right === 6) right--;
    for (let i = 0; i < SIZE; i++) {
      const y = up ? SIZE - 1 - i : i;
      for (const x of [right, right - 1]) if (base[y][x] === -1) positions.push([x, y]);
    }
  }
  let best, lowest = Infinity;
  for (const [mask, applies] of MASKS.entries()) {
    const matrix = base.map((row) => row.slice());
    positions.forEach(([x, y], i) => { matrix[y][x] = bit(codewords[i >> 3], 7 - (i & 7)) ^ Number(applies(x, y)); });
    drawFormat(matrix, mask);
    const score = maskPenalty(matrix);
    if (score < lowest) { best = matrix; lowest = score; }
  }
  return best;
}

function maskPenalty(matrix) {
  const linePenalty = (line) => {
    let score = 0, run = 1;
    for (let i = 1; i < line.length; i++) {
      run = line[i] === line[i - 1] ? run + 1 : 1;
      if (run === 5) score += 3;
      if (run > 5) score++;
    }
    const padded = '0000' + line.join('') + '0000';
    for (let i = 0; i <= padded.length - 11; i++) {
      const pattern = padded.slice(i, i + 11);
      if (pattern === '00001011101' || pattern === '10111010000') score += 40;
    }
    return score;
  };
  let score = 0, dark = 0;
  for (let y = 0; y < SIZE; y++) {
    score += linePenalty(matrix[y]) + linePenalty(matrix.map((row) => row[y]));
    for (let x = 0; x < SIZE; x++) {
      const cell = matrix[y][x];
      dark += cell;
      if (y > 0 && x > 0 && cell === matrix[y][x - 1] && cell === matrix[y - 1][x] && cell === matrix[y - 1][x - 1]) score += 3;
    }
  }
  return score + 10 * Math.floor(Math.abs(dark * 20 - SIZE * SIZE * 10) / (SIZE * SIZE));
}

export function renderQrSvg(payload) {
  const matrix = qrMatrix(qrCodewords(payload));
  const size = SIZE + 8; // Four-module quiet zone on every edge.
  let path = '';
  matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
