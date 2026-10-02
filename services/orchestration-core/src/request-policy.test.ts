import assert from 'node:assert/strict';
import { normalizeOrchestratorRequestOptions, type OrchestratorDecision } from '@atris-agent-code/domain';
import { buildSupervisorDecisionPrompt, decisionToTaskPlan, fallbackSupervisorDecision, normalizeSupervisorDecision, type SupervisorTurnContext } from './supervisor-turn';
import { effectiveWorkMode } from './request-policy';

const context: SupervisorTurnContext = { turnId: 'turn', userMessage: 'Build the feature', conversationContext: '', workspaceContext: '' };
const execute: OrchestratorDecision = { turnId: 'turn', action: 'execute', delegations: [
  { id: 'research', role: 'researcher', objective: 'Inspect requirements', requiredCapabilities: ['write_to_file'] },
  { id: 'builder', role: 'builder', objective: 'Implement', requiredCapabilities: ['implementation'], dependsOnDelegationIds: ['research'] },
] };
assert.deepEqual(normalizeOrchestratorRequestOptions({}), { workMode: 'auto', teamLaunch: 'automatic', attachmentIds: [] });
for (const field of ['workMode', 'teamLaunch', 'attachmentIds']) {
  assert.throws(() => normalizeOrchestratorRequestOptions({ [field]: null } as any));
}
const research = normalizeSupervisorDecision(execute, { ...context, workMode: 'research', explicitTargetRole: 'builder' });
assert.equal(research.action, 'delegate');
assert(decisionToTaskPlan(research).every((task) => task.role === 'researcher' && !task.requiredCapabilities.includes('write_to_file')));
const preview = normalizeSupervisorDecision(execute, { ...context, workMode: 'plan' });
assert.equal(preview.action, 'plan_only');
assert(decisionToTaskPlan(preview).some((task) => task.role === 'builder'));
assert.equal(normalizeSupervisorDecision({ ...research, action: 'delegate' }, { ...context, userMessage: 'Research this', workMode: 'execute' }).action, 'execute');
assert.equal(normalizeSupervisorDecision(execute, { ...context, userMessage: 'Analyze the changes then wait for my approval' }).action, 'delegate');
assert.equal(effectiveWorkMode('auto', 'Show a plan without implementing'), 'plan');
assert.equal(effectiveWorkMode('auto', 'Show a plan, do not implement'), 'plan');
assert.equal(effectiveWorkMode('auto', 'Build the feature', 'plan'), 'plan');
assert.equal(effectiveWorkMode('auto', 'Analiz et, sonra bekle.'), 'research');
assert.equal(effectiveWorkMode('auto', 'Bunu analiz et ve benden cevap bekle.'), 'research');
assert.equal(effectiveWorkMode('execute', 'Build the feature', 'plan'), 'plan', 'the explicit /plan command cannot inherit execution mode');
assert.equal(effectiveWorkMode('execute', 'Analyze then wait'), 'execute', 'explicit mode is the override');
assert.equal(normalizeSupervisorDecision(fallbackSupervisorDecision({ ...context, workMode: 'research' }), { ...context, workMode: 'research' }).action, 'delegate');
assert.equal(normalizeSupervisorDecision(fallbackSupervisorDecision({ ...context, workMode: 'plan' }), { ...context, workMode: 'plan' }).action, 'plan_only');
for (const action of ['respond', 'clarify'] as const) {
  assert.equal(normalizeSupervisorDecision({ turnId: 'turn', action, delegations: [] }, { ...context, teamLaunch: 'confirm' }).action, action);
}
assert(buildSupervisorDecisionPrompt({ ...context, teamLaunch: 'confirm', workMode: 'plan' }).includes('no workers, writes or execution'));
console.log('Request-mode override, fallback, natural-language wait, and strict policy prompt tests passed.');
