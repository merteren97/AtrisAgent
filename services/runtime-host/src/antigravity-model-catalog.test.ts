import { parseAntigravityModelsOutput, resolveAntigravityModelRoute } from './antigravity-model-catalog';

const OUTPUT = `
gemini-3.7-flash-high      Gemini 3.7 Flash (High)
gemini-3.7-flash-medium    Gemini 3.7 Flash (Medium)
gemini-3.7-flash-low       Gemini 3.7 Flash (Low)
gemini-3.6-flash-high      Gemini 3.6 Flash (High)
gemini-3.6-flash-medium    Gemini 3.6 Flash (Medium)
gemini-3.6-flash-low       Gemini 3.6 Flash (Low)
gemini-3.5-flash-high      Gemini 3.5 Flash (High)
gemini-3.5-flash-medium    Gemini 3.5 Flash (Medium)
gemini-3.5-flash-low       Gemini 3.5 Flash (Low)
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
const gemini37 = families.find((family) => family.id === 'gemini-3.7-flash');
const gemini36 = families.find((family) => family.id === 'gemini-3.6-flash');
const claude = families.find((family) => family.id === 'claude-sonnet-4-6');
const gpt = families.find((family) => family.id === 'gpt-oss-120b');

assert(families.length === 7, 'Antigravity 1.1.12 routes collapse into seven user-facing model families');
assert(Boolean(gemini37), 'Gemini 3.7 Flash is discovered from the live CLI catalog');
assert(Boolean(gemini36), 'Gemini 3.6 Flash is discovered from the live CLI catalog');
assert(gemini37?.displayName === 'Gemini 3.7 Flash', 'reasoning suffix is removed from the display name');
assert(JSON.stringify(gemini37?.efforts) === JSON.stringify(['low', 'medium', 'high']), 'Gemini reasoning variants are exposed through the reasoning selector');
assert(resolveAntigravityModelRoute(families, 'gemini-3.7-flash', 'medium') === 'gemini-3.7-flash-medium', 'Gemini family + reasoning resolves to the exact CLI route');
assert(claude?.provider === 'anthropic' && claude.efforts.includes('high'), 'Claude Thinking is normalized as an Anthropic high-reasoning route');
assert(gpt?.provider === 'local' && gpt.efforts.includes('medium'), 'GPT-OSS medium route is normalized without hard-coded model metadata');
