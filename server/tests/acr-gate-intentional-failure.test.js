import assert from 'node:assert/strict';
import { test } from 'node:test';

test('intentional failure for CI publish-gate check', () => {
  assert.fail('Intentional failure: verify that a failed test prevents ACR publishing.');
});
