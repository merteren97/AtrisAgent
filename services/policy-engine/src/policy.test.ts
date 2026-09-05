import { PolicyEngine, resolveAutomationAction } from './policy';

async function runPolicyTests() {
  console.log('--- Starting PolicyEngine Security Controls Tests ---');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  const engine = new PolicyEngine('balanced');

  // Test 1: Path Traversal Protection
  assert(!engine.isPathAllowed('../../etc/passwd'), 'Blocks path traversal with ../');
  assert(!engine.isPathAllowed('src\\..\\..\\secret.txt'), 'Blocks path traversal with Windows ..\\');
  assert(!engine.isPathAllowed('/workspace/.env'), 'Blocks access to .env sensitive file');
  assert(engine.isPathAllowed('src/components/button.tsx'), 'Allows clean relative path');
  assert(!engine.isPathAllowed('/other/dir/file.txt', '/workspace/root'), 'Blocks path outside workspace boundary');
  assert(!engine.isPathAllowed('/workspace/root-secrets/file.txt', '/workspace/root'), 'Blocks sibling paths that only share a string prefix with the workspace');

  // Test 2: Command Denylist Filtering
  const cmdCheck1 = engine.validateCommand('rm -rf /');
  assert(!cmdCheck1.allowed, 'Blocks rm -rf command via denylist');

  const cmdCheck2 = engine.validateCommand('git status');
  assert(cmdCheck2.allowed, 'Allows git status command');

  // Test 3: Secret Redaction
  const rawLog = 'Connecting with sk-proj-1234567890abcdef12345678 and Authorization: Bearer eyJhbGciOi...';
  const redacted = engine.redactSecrets(rawLog);
  assert(!redacted.includes('sk-proj-1234567890abcdef12345678'), 'Redacts API Key from string');
  assert(!redacted.includes('Authorization: Bearer eyJhbGciOi...'), 'Redacts Authorization header from string');
  assert(redacted.includes('[REDACTED_API_KEY]'), 'Includes REDACTED_API_KEY placeholder');

  const objLog = {
    user: 'admin',
    apiKey: 'sk-proj-99999999999999999999',
    config: {
      password: 'super-secret-password',
      normalVal: 'hello',
    },
  };
  const redactedObj = engine.redactObject(objLog);
  assert(redactedObj.apiKey === '[REDACTED]', 'Redacts apiKey object field');
  assert(redactedObj.config.password === '[REDACTED]', 'Redacts password nested object field');
  assert(redactedObj.config.normalVal === 'hello', 'Preserves non-secret fields');

  // Test 4: Trust Modes Matrix
  const reviewEngine = new PolicyEngine('review_driven');
  assert(reviewEngine.getConfig().planApproval === 'always', 'review_driven requires planApproval always');

  const autoEngine = new PolicyEngine('autonomous');
  assert(autoEngine.getConfig().planApproval === 'never', 'autonomous has planApproval never');
  assert(resolveAutomationAction('ask', 'fileWrite') === 'ask', 'Ask profile requires governed file-write approval');
  assert(resolveAutomationAction('review', 'workspaceApply') === 'review', 'Review profile preserves a distinct reviewed workspace apply');
  assert(resolveAutomationAction('auto', 'gitPush') === 'ask', 'Auto profile still requires explicit push approval');
  assert(resolveAutomationAction('auto', 'packageInstall', { packageInstall: 'deny' }) === 'deny', 'per-action override wins over profile defaults');

  console.log(`\nPolicy Test Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runPolicyTests().catch((err) => {
  console.error('Policy test error:', err);
  process.exit(1);
});
