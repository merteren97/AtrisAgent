import assert from 'node:assert/strict';
import {
  inferQualityVerdict,
  parseQualityResultEnvelope,
} from './quality-gate';

// 1. Strict JSON QualityResultEnvelope extraction (bare, fenced, inline).
{
  const bare = JSON.stringify({
    type: 'quality_result',
    version: 1,
    role: 'reviewer',
    verdict: 'pass',
    summary: 'All checks passed cleanly.',
    findings: [],
    evidence: ['npm test passed'],
  });
  const parsedBare = parseQualityResultEnvelope(bare);
  assert.ok(parsedBare && parsedBare !== 'invalid');
  assert.equal(parsedBare.verdict, 'pass');

  const fenced = `\`\`\`json\n${JSON.stringify({
    type: 'quality_result',
    version: 1,
    role: 'qa',
    verdict: 'pass',
    summary: 'QA passed with 0 errors.',
  })}\n\`\`\``;
  const parsedFenced = parseQualityResultEnvelope(fenced);
  assert.ok(parsedFenced && parsedFenced !== 'invalid');
  assert.equal(parsedFenced.role, 'qa');

  const inline = `Verification complete:\n${JSON.stringify({
    type: 'quality_result',
    version: 1,
    role: 'reviewer',
    verdict: 'fail',
    summary: 'Missing validation.',
    findings: ['Null pointer on empty input'],
  })}\nEnd of report.`;
  const verdict = inferQualityVerdict('reviewer', inline);
  assert.equal(verdict?.passed, false);
  assert.equal(verdict?.reason, 'failed');
  assert.equal(verdict?.findingCount, 1);

  // Malformed quality envelope fails closed.
  assert.equal(parseQualityResultEnvelope('{"type":"quality_result","version":1,"role":"qa","verdict":"pass"}'), 'invalid');
  const malformedVerdict = inferQualityVerdict('qa', '{"type":"quality_result","version":1,"role":"qa","verdict":"pass"}');
  assert.equal(malformedVerdict?.passed, false);
  assert.equal(malformedVerdict?.reason, 'ambiguous');
}

// 2. Benign prose negative cases must NEVER false-positive as a quality failure.
{
  const benignReports = [
    'Approved. Build and typecheck passed with 0 errors.',
    'Passed: no failures observed across the test suite.',
    'Approved. All checks pass with no pending issues.',
    'Passed with no pending work remaining.',
    'Approved: fixed the error and all tests pass.',
    'QA passed. 0 errors, 0 failures, no pending errors.',
  ];

  for (const report of benignReports) {
    const verdict = inferQualityVerdict('qa', report);
    assert.equal(verdict?.passed, true, `Expected benign report to pass: ${report} -> got ${JSON.stringify(verdict)}`);
    assert.equal(verdict?.reason, 'approved');
    assert.equal(verdict?.findingCount, 0);
  }
}

// 3. Real failure detection in prose and contradictory envelopes.
{
  const realFailures = [
    'Tests failed with 2 errors.',
    'Approved, but lint failed on src/index.ts.',
    'Not fixed syntax errors.',
    'Fixed the error, but tests failed.',
    'Changes requested: missing error handling.',
    'Blocked on failing integration tests.',
  ];

  for (const report of realFailures) {
    const verdict = inferQualityVerdict('reviewer', report);
    assert.equal(verdict?.passed, false, `Expected failure report to fail: ${report}`);
    assert.equal(verdict?.reason, 'failed');
  }

  // Contradictory structured pass must still fail closed.
  const contradictory = JSON.stringify({
    type: 'quality_result',
    version: 1,
    role: 'qa',
    verdict: 'pass',
    summary: 'Build passed.',
    findings: ['npm run lint failed with exit code 1.'],
  });
  const contradictoryVerdict = inferQualityVerdict('qa', contradictory);
  assert.equal(contradictoryVerdict?.passed, false);
  assert.equal(contradictoryVerdict?.reason, 'ambiguous');
}

// Non-quality roles return null.
assert.equal(inferQualityVerdict('builder', 'Approved.'), null);

console.log('[PASS] quality-gate strict envelope, benign prose, and failure detection tests');
