import nodeAssert from 'node:assert/strict';
import { parseAntigravityModelsOutput, resolveAntigravityCliRoute, resolveAntigravityModelRoute } from './antigravity-model-catalog';

const OUTPUT = `
gemini-3.8-flash-high      Gemini 3.8 Flash (High)
gemini-3.8-flash-medium    Gemini 3.8 Flash (Medium)
gemini-3.8-flash-low       Gemini 3.8 Flash (Low)
gemini-3.7-flash-high      Gemini 3.7 Flash (High)
gemini-3.7-flash-medium    Gemini 3.7 Flash (Medium)
gemini-3.7-flash-low       Gemini 3.7 Flash (Low)
gemini-3.6-flash-high      Gemini 3.6 Flash (High)
gemini-3.6-flash-medium    Gemini 3.6 Flash (Medium)
gemini-3.6-flash-low       Gemini 3.6 Flash (Low)
gemini-3.1-pro-high        Gemini 3.1 Pro (High)
gemini-3.1-pro-low         Gemini 3.1 Pro (Low)
claude-sonnet-4-6          Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking   Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium        GPT-OSS 120B (Medium)
`;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`[PASS] ${message}`);
}

const families = parseAntigravityModelsOutput(OUTPUT);
const gemini38 = families.find((family) => family.id === 'gemini-3.8-flash');
const gemini37 = families.find((family) => family.id === 'gemini-3.7-flash');
const gemini36 = families.find((family) => family.id === 'gemini-3.6-flash');
const claude = families.find((family) => family.id === 'claude-sonnet-4-6');
const gpt = families.find((family) => family.id === 'gpt-oss-120b');

assert(families.length === 7, 'Antigravity 1.1.12 routes collapse into seven user-facing model families');
assert(Boolean(gemini38), 'Gemini 3.8 Flash is discovered from the current AGY table catalog');
assert(JSON.stringify(gemini38?.efforts) === JSON.stringify(['low', 'medium', 'high']), 'Gemini 3.8 exposes low, medium, and high reasoning routes');
assert(resolveAntigravityModelRoute(families, 'gemini-3.8-flash', 'high') === 'gemini-3.8-flash-high', 'Gemini 3.8 family + reasoning resolves to the exact CLI route');
assert(Boolean(gemini37), 'Gemini 3.7 Flash is discovered from the live CLI catalog');
assert(Boolean(gemini36), 'Gemini 3.6 Flash is discovered from the live CLI catalog');
assert(gemini37?.displayName === 'Gemini 3.7 Flash', 'reasoning suffix is removed from the display name');
assert(JSON.stringify(gemini37?.efforts) === JSON.stringify(['low', 'medium', 'high']), 'Gemini reasoning variants are exposed through the reasoning selector');
assert(resolveAntigravityModelRoute(families, 'gemini-3.7-flash', 'medium') === 'gemini-3.7-flash-medium', 'Gemini family + reasoning resolves to the exact CLI route');
assert(claude?.provider === 'anthropic' && claude.efforts.includes('high'), 'Claude Thinking is normalized as an Anthropic high-reasoning route');
assert(gpt?.provider === 'local' && gpt.efforts.includes('medium'), 'GPT-OSS medium route is normalized without hard-coded model metadata');

const originalCatalog = JSON.stringify(families);
const selections = [
  ['claude-opus-4-6', 'high', 'claude-opus-4-6-thinking'],
  ['claude-opus-4-6-thinking', 'high', 'claude-opus-4-6-thinking'],
  ['claude-sonnet-4-6', 'high', 'claude-sonnet-4-6'],
  ['gemini-3.8-flash', 'low', 'gemini-3.8-flash-low'],
  ['gemini-3.8-flash', 'medium', 'gemini-3.8-flash-medium'],
  ['gemini-3.8-flash', 'high', 'gemini-3.8-flash-high'],
  ['gemini-3.8-flash-low', 'low', 'gemini-3.8-flash-low'],
  ['gpt-oss-120b', 'medium', 'gpt-oss-120b-medium'],
] as const;
for (const [model, reasoning, route] of selections) {
  nodeAssert.deepEqual(resolveAntigravityCliRoute(families, model, reasoning), {
    modelRoute: route, args: ['--model', route],
  }, `${model} + ${reasoning} selects the exact route without unsupported --effort`);
}
console.log('[PASS] Opus, unsuffixed Sonnet Thinking, Gemini variants and GPT-OSS produce exact model-only CLI arguments');
nodeAssert.equal(resolveAntigravityModelRoute(families, 'claude-opus-4-6', 'high'), 'claude-opus-4-6-thinking');
nodeAssert.equal(resolveAntigravityCliRoute(families, 'gemini-3.8-flash').modelRoute, 'gemini-3.8-flash-high');
nodeAssert.equal(resolveAntigravityCliRoute(families, 'gemini-3.8-flash-low').modelRoute, 'gemini-3.8-flash-low', 'An explicit low route is not changed to the family default');
nodeAssert.equal(resolveAntigravityCliRoute(families, 'claude-opus-4-6', 'Thinking').modelRoute, 'claude-opus-4-6-thinking');
nodeAssert.equal(JSON.stringify(families), originalCatalog, 'Resolution preserves persisted family IDs and does not mutate the catalog');
console.log('[PASS] Defaults, exact routes and Thinking aliases preserve family compatibility without catalog mutation');

nodeAssert.throws(() => resolveAntigravityCliRoute(families, 'gemini-3.8-flash-low', 'high'), /conflicts with reasoning/);
nodeAssert.throws(() => resolveAntigravityModelRoute(families, 'claude-opus-4-6-thinking', 'low'), /conflicts with reasoning/);
nodeAssert.throws(() => resolveAntigravityCliRoute(families, 'claude-sonnet-4-6', 'low'), /does not support reasoning/);
nodeAssert.throws(() => resolveAntigravityCliRoute(families, 'gemini-3.1-pro', 'medium'), /does not support reasoning/);
nodeAssert.throws(() => resolveAntigravityCliRoute(families, 'gemini-3.8-flash', 'typo'), /Invalid Antigravity reasoning/);
nodeAssert.throws(() => resolveAntigravityCliRoute(families, 'missing-model'), /not present in the live model catalog/);
nodeAssert.throws(() => resolveAntigravityCliRoute([], 'claude-opus-4-6'), /not present in the live model catalog/);
nodeAssert.throws(() => resolveAntigravityCliRoute([...families, { ...gemini38!, id: 'duplicate-family' }], 'gemini-3.8-flash-high'), /ambiguous/);
console.log('[PASS] Contradictory exact routes, unsupported reasoning and unverifiable catalog selections fail explicitly');

nodeAssert.deepEqual(resolveAntigravityCliRoute([], 'antigravity-active-route'), { args: [] });
nodeAssert.throws(() => resolveAntigravityCliRoute(families, 'antigravity-active-route', 'high'), /does not expose reasoning control/);
const plain = parseAntigravityModelsOutput('plain-model-1\tPlain Model');
nodeAssert.deepEqual(resolveAntigravityCliRoute(plain, 'plain-model-1'), { modelRoute: 'plain-model-1', args: ['--model', 'plain-model-1'] });
nodeAssert.throws(() => resolveAntigravityCliRoute(plain, 'plain-model-1', 'high'), /does not support reasoning/);
const jsonCatalog = parseAntigravityModelsOutput(JSON.stringify({ models: [
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)' },
] }));
nodeAssert.deepEqual(resolveAntigravityCliRoute(jsonCatalog, 'claude-sonnet-4-6', 'high').args, ['--model', 'claude-sonnet-4-6']);
console.log('[PASS] Synthetic active routes and unannotated models never invent effort support; JSON Thinking metadata also encodes the route');
