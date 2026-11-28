import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateLocalTarget } from '../scripts/test-kubernetes.js';

test('Kubernetes system probe accepts only the dedicated local Kind context and loopback server', () => {
  assert.doesNotThrow(() => validateLocalTarget({ context: 'kind-agridispatch-ready', server: 'https://127.0.0.1:6443', image: 'agridispatch-vn:kind-ab4c47b', buildSha: 'a'.repeat(40) }));
  for (const override of [{ context: 'aks-production' }, { server: 'https://example.org:6443' }, { server: 'http://127.0.0.1:6443' }, { server: 'https://user@127.0.0.1:6443' }, { image: 'external.azurecr.io/app:latest' }, { buildSha: 'main' }]) {
    assert.throws(() => validateLocalTarget({ context: 'kind-agridispatch-ready', server: 'https://127.0.0.1:6443', image: 'agridispatch-vn:kind-ab4c47b', buildSha: 'a'.repeat(40), ...override }), /Invalid local Kubernetes test target/);
  }
});
