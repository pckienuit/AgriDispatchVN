# Auth Proxy Identity & Deployment Guide

## 1. Trust Boundary

`account-service` runs on an internal network (not directly exposed to public internet traffic). Public auth requests enter through `booking-service` (`createAccountGateway`), which resolves the client IP from trusted proxy hops, signs a short-lived client-identity envelope, and forwards requests to `account-service` (`createAccountApp`).

- `booking-service` never uses blind `app.set('trust proxy', true)`.
- `account-service` ignores unauthenticated `X-Forwarded-For` / `Forwarded` headers on direct connections and falls back to normalized `req.socket.remoteAddress` unless valid signed `X-Client-*` headers are present (or rejects unsigned `/api/*` requests with `400 INVALID_CLIENT_IDENTITY` when `requireSignedClientIdentity: true`).

## 2. Gateway -> Account Signed Identity Contract

When `createAccountGateway` receives `internalServiceToken` (32..256 chars, no whitespace), it derives a dedicated HMAC-SHA256 signing key (`HMAC(token, "agridispatch-client-identity-v1")`) via `deriveClientIdentityKey` in `server/src/client-identity.js`.

For each proxied auth or role-request route:
1. Client-supplied `X-Client-Address`, `X-Client-Timestamp`, `X-Client-Signature`, and `X-Service-Token` are never forwarded.
2. Gateway resolves the canonical client IP (`normalizeIp`: IPv4, canonical lowercase IPv6, and IPv4-mapped IPv6 unwrapping `::ffff:a.b.c.d` -> `a.b.c.d`).
3. Gateway sets:
   - `X-Client-Address`: canonical client IP (`<= 100` bytes)
   - `X-Client-Timestamp`: epoch milliseconds string (`<= 100` bytes)
   - `X-Client-Signature`: 64-char lowercase hex HMAC-SHA256 over:
     `v1\n<address>\n<timestamp>\n<requestId>\n<METHOD>\n<req.path>`
   - `X-Request-ID`: sanitized request ID (generated if absent when signing is active).

On `account-service`:
- If any of `X-Client-Address`, `X-Client-Timestamp`, or `X-Client-Signature` is present:
  - All three must be present, within `100` characters, valid IP / timestamp / 64-hex signature.
  - Timestamp must be within `60000` ms (`DEFAULT_CLIENT_IDENTITY_TTL_MS`) of server time.
  - Signature is checked with `crypto.timingSafeEqual` against the request's `X-Request-ID`, `req.method`, and `req.path` (excluding query parameters).
  - Invalid, partial, expired, or mismatched headers fail immediately with `400 { "error": { "code": "INVALID_CLIENT_IDENTITY" } }` before DB or scrypt work.
- If `requireSignedClientIdentity: true`, unsigned `/api/*` requests also fail closed with `400 INVALID_CLIENT_IDENTITY` while `/health` and `/ready` remain reachable for cluster probes.

## 3. Proxy Hop & CIDR Configuration

Configure `trustedProxyHops` (integer `0..10`, default `0`) and optional `trustedProxyCidrs` on `createAccountGateway`:

- **Direct / single container (`0`, default):** Ignores `X-Forwarded-For` completely and signs `req.socket.remoteAddress`.
- **Azure App Service / single reverse proxy (`1`):** Unwraps 1 trusted rightmost hop from `X-Forwarded-For` when the immediate socket peer is trusted. Spoofed leftmost `X-Forwarded-For` values appended by clients are ignored.
- **Multi-hop ingress (e.g. CDN/Front Door + AKS Ingress -> Pod):** Set `trustedProxyHops` to the exact hop count added by infrastructure you control and restrict `trustedProxyCidrs` to known ingress/load-balancer CIDRs. If the direct socket peer is outside `trustedProxyCidrs`, `X-Forwarded-For` is ignored and the peer address is used.

## 4. Throttling Semantics & Residual Limits

Default production thresholds in `server/src/account-app.js` (900-second window):

| Scope | Key | Max / 900s | Behavior |
|---|---|---:|---|
| `register-ip` | canonical client IP | 10 | Counts registration attempts per client IP. |
| `login-email` | `[normalizedEmail, clientIp]` | 5 | Prevents one attacker IP from locking out a victim email for users on other IPs. Cleared only for `(email, clientIp)` on valid login. |
| `login-ip` | canonical client IP | 30 | Pre-scrypt failure budget per client IP. Valid logins release their own hit so legitimate traffic behind a shared NAT does not exhaust the IP budget. |

**Known residual:** Attackers sharing the exact same client NAT IP as a legitimate user share `(email, natIp)` and `login-ip` ceilings with users behind that same NAT IP.

## 5. Logging & Privacy

- `account.rate_limits` stores SHA-256 digests (`bucket`), never raw emails or client IPs.
- Request logs record method, status, duration, and `requestId` only; client IPs, emails, passwords, tokens, and signatures are never logged.

## 6. Required Parent Wiring (`server/src/app.js`, `config.js`, `server.js`)

Keep `app.js`, `config.js`, and `server.js` wired so `booking-service` passes:
- `internalServiceToken` into `createAccountGateway(...)`
- bounded numeric `TRUST_PROXY_HOPS` (`0..10`, default `0`) and optional `TRUSTED_PROXY_CIDRS` from environment configuration.
