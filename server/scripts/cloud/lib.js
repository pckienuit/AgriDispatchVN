// Shared helpers for the cloud release scripts. Stdlib only.
// Process calls use argv arrays (no shell). Errors carry a code and never a secret or raw stderr.
import { execFile } from 'node:child_process';

export const RESOURCE_GROUP = 'rg-agridispatch-bt05';
export const IMAGE_PATTERN = /^[a-z0-9]{5,50}\.azurecr\.io\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/;
export const SHA_PATTERN = /^[0-9a-f]{40}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BUDGET_GATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

export function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

// spec: { '--flag': { key: 'name' } } for values, { key, flag: true } for booleans.
export function parseFlags(argv, spec) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const entry = Object.hasOwn(spec, token) ? spec[token] : undefined;
    if (!entry) throw coded('UNKNOWN_FLAG', `Unknown argument: ${token}`);
    if (entry.flag) {
      out[entry.key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw coded('MISSING_VALUE', `Missing value for ${token}`);
    out[entry.key] = value;
    index += 1;
  }
  return out;
}

export function runCommand(argv, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout: String(stdout ?? '') });
    });
  });
}

// stderr is not returned: cloud CLIs can echo request details, so only the exit code is reported.
export function requireOk(result, label) {
  if (result.code !== 0) throw coded('COMMAND_FAILED', `${label} exited ${result.code}`);
  return result.stdout;
}

export function parseJsonOutput(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw coded('BAD_JSON_OUTPUT', `${label} returned non-JSON output`);
  }
}

export function assertTargetAccount(accountJson, subscriptionId) {
  if (String(accountJson?.id ?? '').toLowerCase() !== subscriptionId.toLowerCase()) {
    throw coded('SUBSCRIPTION_MISMATCH', 'Active Azure subscription does not match --subscription');
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
