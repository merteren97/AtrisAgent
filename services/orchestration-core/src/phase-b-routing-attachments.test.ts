import assert from 'node:assert/strict';
import { LocalEventBus } from '@atris-agent-code/event-bus';
import type { AgentEvent } from '@atris-agent-code/event-schema';
import type { OrchestratorRoutingDefaults, ProviderAttachment } from '@atris-agent-code/domain';
import { buildSupervisorDecisionPrompt, decisionToTaskPlan } from './supervisor-turn';
import { OrchestratorV2 } from './orchestrator-v2';

async function main() {
  // 1. Preserve explicit tailored reviewer/qa nodes while auto-injecting for uncovered builders
  const customVerificationPlan = decisionToTaskPlan({
    turnId: 'turn-custom-verify',
    action: 'execute',
    delegations: [
      {
        id: 'b-auth',
        role: 'builder',
        displayName: 'Auth Builder',
        sandboxTier: 'implement',
        objective: 'Implement JWT rotation',
        requiredCapabilities: ['TypeScript'],
      },
      {
        id: 'b-ui',
        role: 'builder',
        objective: 'Update login form',
        requiredCapabilities: ['React'],
      },
      {
        id: 'rev-sec',
        role: 'reviewer',
        displayName: 'Security Auditor',
        specialty: 'auth-security',
        sandboxTier: 'verify',
        objective: 'Audit JWT rotation for token replay and key handling',
        requiredCapabilities: ['security-review'],
        dependsOnDelegationIds: ['b-auth'],
      },
      {
        id: 'qa-sec',
        role: 'qa',
        displayName: 'Auth E2E Verifier',
        sandboxTier: 'verify',
        objective: 'Run auth integration suite',
        requiredCapabilities: ['testing'],
        dependsOnDelegationIds: ['rev-sec'],
      },
    ],
  });

  assert.equal(customVerificationPlan.length, 6, 'preserves custom reviewer/qa for b-auth and auto-generates for uncovered b-ui');
  const preservedReviewer = customVerificationPlan.find((t) => t.displayName === 'Security Auditor');
  const preservedQa = customVerificationPlan.find((t) => t.displayName === 'Auth E2E Verifier');
  assert(preservedReviewer && preservedReviewer.role === 'reviewer' && preservedReviewer.specialty === 'auth-security',
    'custom reviewer persona and specialty are preserved');
  assert(preservedQa && preservedQa.role === 'qa' && preservedQa.sandboxTier === 'verify',
    'custom QA persona and sandboxTier are preserved');
  assert.equal(
    customVerificationPlan.filter((t) => t.role === 'reviewer').length,
    2,
    'exactly one reviewer per builder lane (1 preserved + 1 auto-generated)',
  );
  assert.equal(
    customVerificationPlan.filter((t) => t.role === 'qa').length,
    2,
    'exactly one QA per builder lane (1 preserved + 1 auto-generated)',
  );

  // 2. Builder with explicit reviewer but no explicit QA gets auto-generated QA depending on explicit reviewer
  const partialVerifyPlan = decisionToTaskPlan({
    turnId: 'turn-partial-verify',
    action: 'plan_only',
    delegations: [
      { id: 'b1', role: 'builder', objective: 'Build API', requiredCapabilities: [] },
      { id: 'r1', role: 'reviewer', displayName: 'API Reviewer', objective: 'Review API', requiredCapabilities: [], dependsOnDelegationIds: ['b1'] },
    ],
  });
  assert.equal(partialVerifyPlan.length, 3, 'partial explicit verification auto-generates missing QA only');
  assert.equal(partialVerifyPlan[1]?.displayName, 'API Reviewer', 'explicit reviewer is preserved');
  assert.equal(partialVerifyPlan[2]?.role, 'qa', 'missing QA is auto-generated');
  assert.deepEqual(partialVerifyPlan[2]?.dependsOnIndices, [1], 'auto-generated QA depends on preserved explicit reviewer');

  // 3. 3-Layer Tiered Routing Defaults injection (per-task > workerRoutes > tier defaults)
  const routingDefaults: OrchestratorRoutingDefaults = {
    worker: { modelCatalogId: 'codex:default:gpt-5.4', reasoningLevel: 'medium', fallbackCatalogIds: ['codex:default:gpt-5.3-codex'] },
    review: { modelCatalogId: 'claude_code:default:claude-sonnet-4-6', reasoningLevel: 'high', fallbackCatalogIds: [] },
  };
  const tieredPlan = decisionToTaskPlan({
    turnId: 'turn-tiered',
    action: 'execute',
    workerRoutes: {
      researcher: {
        modelCatalogId: 'opencode:default:gemini-2.5-pro',
        accountProfileId: 'acc-opencode',
        fallbackCatalogIds: [],
        selectionMode: 'fixed',
        modelDisplayName: 'Gemini 2.5 Pro',
      },
    },
    delegations: [
      { id: 'res-1', role: 'researcher', objective: 'Research architecture', requiredCapabilities: [] },
      { id: 'bld-1', role: 'builder', objective: 'Build feature', requiredCapabilities: [] },
      {
        id: 'bld-2',
        role: 'builder',
        objective: 'Build UI',
        requiredCapabilities: [],
        routePreference: {
          modelCatalogId: 'antigravity:default:claude-opus-4-6',
          accountProfileId: 'acc-ag',
          fallbackCatalogIds: [],
          selectionMode: 'fixed',
          modelDisplayName: 'Claude Opus 4.6',
        },
      },
    ],
  }, { routingDefaults });

  const resTask = tieredPlan.find((t) => t.role === 'researcher');
  const bld1Task = tieredPlan.find((t) => t.description === 'Build feature');
  const bld2Task = tieredPlan.find((t) => t.description === 'Build UI');
  const revTasks = tieredPlan.filter((t) => t.role === 'reviewer');
  const qaTasks = tieredPlan.filter((t) => t.role === 'qa');
  assert.equal(resTask?.routePreference?.modelCatalogId, 'opencode:default:gemini-2.5-pro', 'workerRoutes overrides worker tier default');
  assert.equal(bld1Task?.routePreference?.modelCatalogId, 'codex:default:gpt-5.4', 'worker tier default injected into builder without override');
  assert.equal(bld1Task?.routePreference?.reasoningLevel, 'medium', 'worker tier reasoningLevel preserved');
  assert.equal(bld2Task?.routePreference?.modelCatalogId, 'antigravity:default:claude-opus-4-6', 'per-task routePreference overrides tier default');
  assert(revTasks.every((t) => t.routePreference?.modelCatalogId === 'claude_code:default:claude-sonnet-4-6' && t.routePreference?.reasoningLevel === 'high'),
    'review tier default injected into generated reviewer tasks');
  assert(qaTasks.every((t) => t.routePreference?.modelCatalogId === 'claude_code:default:claude-sonnet-4-6'),
    'review tier default injected into generated QA tasks');

  const promptWithDefaults = buildSupervisorDecisionPrompt({
    turnId: 'turn-prompt-defaults',
    userMessage: 'Implement feature',
    conversationContext: '',
    workspaceContext: '',
    routingDefaults,
  });
  assert(promptWithDefaults.includes('Tier routing defaults') && promptWithDefaults.includes('codex:default:gpt-5.4'),
    'buildSupervisorDecisionPrompt includes tier routing defaults when configured');

  // 4. Attachments propagated onto task_created events
  const eventBus = new LocalEventBus();
  const taskCreatedEvents: Array<Extract<AgentEvent, { type: 'task_created' }> & { attachments?: ProviderAttachment[] }> = [];
  eventBus.on('task_created', (event) => {
    taskCreatedEvents.push(event as Extract<AgentEvent, { type: 'task_created' }> & { attachments?: ProviderAttachment[] });
  });
  const orchestrator = new OrchestratorV2({
    workspacePath: process.cwd(),
    executionMode: 'autonomous',
  }, eventBus);

  const sampleAttachment: ProviderAttachment = {
    id: 'att-1',
    workspaceId: 'ws-1',
    name: 'mockup.png',
    mimeType: 'image/png',
    byteSize: 1024,
    sha256: 'deadbeef',
    createdAt: new Date().toISOString(),
    providerPath: '/tmp/mockup.png',
  };
  await orchestrator.startMission('mission-attachments-1', 'Research the mockup', {
    workMode: 'research',
    attachments: [sampleAttachment],
  });
  assert.equal(taskCreatedEvents.length, 1, 'task_created emitted for research mission');
  assert.equal(taskCreatedEvents[0]?.attachments?.length, 1, 'attachments propagated onto task_created');
  assert.equal(taskCreatedEvents[0]?.attachments?.[0]?.id, 'att-1', 'attachment payload matches');

  console.log('--- Phase B Routing & Attachments Tests Complete: all passed ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
