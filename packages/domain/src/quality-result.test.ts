import assert from 'node:assert/strict';
import { parseQualityResultEnvelope } from './quality-result';

const mixed = '[legacy_compatibility_fallback] Waiting for build process to complete.\n'
  + JSON.stringify({
    type: 'quality_result', version: 1, role: 'reviewer', verdict: 'pass',
    summary: 'Production build passed with zero errors.', findings: ['No blocking findings.'], evidence: ['409 Conflict response was observed during an unrelated probe.', 'diff inspected'],
  });
const parsed = parseQualityResultEnvelope(mixed);
assert.equal(parsed && parsed !== 'invalid' ? parsed.type : undefined, 'quality_result');
assert.equal(parsed && parsed !== 'invalid' ? parsed.verdict : undefined, 'pass');

assert.equal(parseQualityResultEnvelope('plain prose without a structured result'), null);
assert.equal(parseQualityResultEnvelope('{"type":"quality_result","version":1,"role":"reviewer","verdict":"pass"}'), 'invalid');
assert.equal(parseQualityResultEnvelope('prefix {"type":"quality_result","version":1,"role":"reviewer","verdict":"pass"'), 'invalid');
assert.equal(parseQualityResultEnvelope('prefix {"type":"quality_result","version":1,"role":"reviewer",}'), 'invalid');
assert.equal(parseQualityResultEnvelope(`${JSON.stringify({ type: 'quality_result', version: 1, role: 'reviewer', verdict: 'pass', summary: 'ok' })} trailing prose`)
  && parseQualityResultEnvelope(`${JSON.stringify({ type: 'quality_result', version: 1, role: 'reviewer', verdict: 'pass', summary: 'ok' })} trailing prose`) !== 'invalid', true);
assert.equal(parseQualityResultEnvelope(
  `${JSON.stringify({ type: 'quality_result', version: 1, role: 'reviewer', verdict: 'pass', summary: 'one' })}\n${JSON.stringify({ type: 'quality_result', version: 1, role: 'reviewer', verdict: 'pass', summary: 'two' })}`,
), 'invalid');
const quotedProse = parseQualityResultEnvelope(
  `A quote that never closes: " then ${JSON.stringify({ type: 'quality_result', version: 1, role: 'reviewer', verdict: 'pass', summary: 'ok' })}`,
);
assert.equal(quotedProse && quotedProse !== 'invalid' ? quotedProse.verdict : undefined, 'pass');

console.log('[PASS] quality-result parser accepts mixed compatibility prose with strict embedded envelopes');
