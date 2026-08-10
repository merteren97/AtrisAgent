import assert from 'node:assert/strict';
import { validateNativeRuntimeConfig } from './runtime-config';

assert.deepEqual(
  validateNativeRuntimeConfig({
    origin: 'http://127.0.0.1:43127',
    runtimeToken: null,
    transportProtected: false,
  }, true),
  { origin: 'http://127.0.0.1:43127', runtimeToken: null },
);

assert.throws(
  () => validateNativeRuntimeConfig({
    origin: 'http://127.0.0.1:43127',
    runtimeToken: null,
    transportProtected: false,
  }, false),
  /protected transport/,
);

assert.throws(
  () => validateNativeRuntimeConfig({
    origin: 'http://127.0.0.1:43127',
    runtimeToken: '  ',
    transportProtected: true,
  }, false),
  /transport token/,
);

assert.deepEqual(
  validateNativeRuntimeConfig({
    origin: 'http://127.0.0.1:43127',
    runtimeToken: '  runtime-secret  ',
    transportProtected: true,
  }, false),
  { origin: 'http://127.0.0.1:43127', runtimeToken: 'runtime-secret' },
);

console.log('desktop runtime protection contract passed');
