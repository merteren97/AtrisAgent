import { LocalEventBus } from './event-bus';
import {
  REDACTED_SECRET_VALUE,
  redactSensitiveString,
  redactSensitiveValue,
} from './secret-redaction';

async function runTests() {
  let passed = 0;
  let failed = 0;
  const assert = (condition: boolean, message: string) => {
    if (condition) {
      passed += 1;
      console.log(`[PASS] ${message}`);
    } else {
      failed += 1;
      console.error(`[FAIL] ${message}`);
    }
  };

  const rawJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdHJpcy11c2VyIn0.abcdefghijklmnopqrstuvwxyz123456';
  const nested = redactSensitiveValue({
    token: rawJwt,
    accessToken: 'opaque-access-token-without-known-prefix',
    metadata: {
      authorization: 'Bearer opaque-session-token',
      tokenEstimate: 1234,
      inputTokens: 456,
      note: `Authorization: Bearer abcdefghijklmnopqrstuvwxyz ${rawJwt}`,
    },
  }) as any;

  assert(nested.token === REDACTED_SECRET_VALUE, 'redacts exact token keys even when the credential has no known prefix');
  assert(nested.accessToken === REDACTED_SECRET_VALUE, 'redacts normalized accessToken keys');
  assert(nested.metadata.authorization === REDACTED_SECRET_VALUE, 'redacts nested authorization fields');
  assert(nested.metadata.tokenEstimate === 1234, 'preserves non-secret tokenEstimate telemetry');
  assert(nested.metadata.inputTokens === 456, 'preserves non-secret token-count telemetry');
  assert(!String(nested.metadata.note).includes(rawJwt), 'redacts JWT-like credentials embedded in free-form text');

  const privateKey = '-----BEGIN PRIVATE KEY-----\nvery-secret-key-material\n-----END PRIVATE KEY-----';
  assert(!redactSensitiveString(privateKey).includes('very-secret-key-material'), 'redacts PEM private key blocks');
  assert(redactSensitiveString('github_pat_abcdefghijklmnopqrstuvwxyz1234567890') === REDACTED_SECRET_VALUE, 'redacts GitHub fine-grained token text');

  const bus = new LocalEventBus();
  let specific: any;
  let wildcard: any;
  bus.on('text_delta', (event) => { specific = event; });
  bus.on('*', (event) => { wildcard = event; });
  const sourceEvent = {
    id: crypto.randomUUID(),
    type: 'text_delta' as const,
    missionId: 'mission-secret-test',
    agentInstanceId: 'agent-secret-test',
    content: 'result is safe',
    timestamp: new Date().toISOString(),
    token: 'opaque-secret-value',
    details: {
      password: 'correct-horse-battery-staple',
      tokenEstimate: 99,
    },
  } as any;

  bus.emit(sourceEvent);
  assert(specific?.token === REDACTED_SECRET_VALUE, 'specific subscribers receive sanitized events');
  assert(wildcard?.details?.password === REDACTED_SECRET_VALUE, 'wildcard persistence subscribers receive sanitized nested secrets');
  assert(wildcard?.details?.tokenEstimate === 99, 'sanitization preserves safe telemetry for persistence');
  assert(sourceEvent.token === 'opaque-secret-value', 'event sanitization does not mutate the producer-owned source object');

  console.log(`Event bus security tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
