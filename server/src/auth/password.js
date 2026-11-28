import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_BYTES = 64;
const SALT_BYTES = 16;
const FORMAT = /^scrypt:v1:N=16384:r=8:p=1:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{86})$/;

function deriveKey(password, salt) {
  return scryptAsync(password, salt, KEY_BYTES, PARAMS);
}

// Format: scrypt:v1:N=16384:r=8:p=1:<salt base64url>:<key base64url>. Unknown versions or weaker parameters never verify.
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt);
  return `scrypt:v1:N=${PARAMS.N}:r=${PARAMS.r}:p=${PARAMS.p}:${salt.toString('base64url')}:${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const match = FORMAT.exec(typeof stored === 'string' ? stored : '');
  if (!match) return false;
  const actual = await deriveKey(password, Buffer.from(match[1], 'base64url'));
  return timingSafeEqual(actual, Buffer.from(match[2], 'base64url'));
}
