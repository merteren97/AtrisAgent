import assert from 'node:assert/strict';
import { runtimeBootstrapErrorMessage, validateNativeRuntimeConfig } from './runtime-config';

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

assert.equal(
  runtimeBootstrapErrorMessage(' Packaged runtime resources are incomplete. '),
  'Packaged runtime resources are incomplete.',
);
assert.equal(
  runtimeBootstrapErrorMessage({ message: 'Gateway exited before readiness.' }),
  'Gateway exited before readiness.',
);
assert.equal(
  runtimeBootstrapErrorMessage(new Error('Native launcher failed.')),
  'Native launcher failed.',
);
assert.equal(
  runtimeBootstrapErrorMessage(null),
  'The local AtrisAgent runtime could not be started.',
);

console.log('desktop runtime protection contract passed');
