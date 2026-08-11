import assert from 'node:assert/strict';
import {
  DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT,
  resolveAntigravityPrintTimeout,
} from './antigravity-run-policy';

assert.equal(DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT, '20m');
assert.equal(resolveAntigravityPrintTimeout(undefined), '20m');
assert.equal(resolveAntigravityPrintTimeout('45m'), '45m');
assert.equal(resolveAntigravityPrintTimeout(' 900s '), '900s');
assert.equal(resolveAntigravityPrintTimeout('2H'), '2h');
assert.equal(resolveAntigravityPrintTimeout('0m'), '20m');
assert.equal(resolveAntigravityPrintTimeout('20m --model injected'), '20m');
assert.equal(resolveAntigravityPrintTimeout('forever'), '20m');

console.log('Antigravity background run policy tests passed');
