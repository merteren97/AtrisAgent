import { decisionToTaskPlan, inferExplicitBuilderTarget, isPriorResearchImplementationFollowUp, normalizeSupervisorDecision, parseSupervisorDecision } from './supervisor-turn';

function runTests() {
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

  console.log('--- Supervisor Turn Policy Tests ---');

  const decision = parseSupervisorDecision(JSON.stringify({
    action: 'execute',
    response: 'parallel work',
    delegations: [
      { id: 'r1', role: 'researcher', objective: 'Research A', requiredCapabilities: [] },
      { id: 'r2', role: 'researcher', objective: 'Research B', requiredCapabilities: [] },
      { id: 'r3', role: 'researcher', objective: 'Research C', requiredCapabilities: [] },
      { id: 'r4', role: 'researcher', objective: 'Research D', requiredCapabilities: [] },
      { id: 'b1', role: 'builder', objective: 'Build A', requiredCapabilities: [] },
      { id: 'b2', role: 'builder', objective: 'Build B', requiredCapabilities: [] },
      { id: 'b3', role: 'builder', objective: 'Build C', requiredCapabilities: [] },
    ],
  }), 'turn-capacity');

  assert(Boolean(decision), 'structured supervisor decision parses');
  assert(decision?.delegations?.filter((item) => item.role === 'researcher').length === 3, 'Researcher fan-out is capped at three');
  assert(decision?.delegations?.filter((item) => item.role === 'builder').length === 2, 'Builder fan-out is capped at two');
  const rootDelegations = (decision?.delegations || []).filter((item) => !(item.dependsOnDelegationIds || []).length);
  assert(rootDelegations.length === 4, 'global initial parallel fan-out is capped at four');
  assert((decision?.delegations || []).some((item) => (item.dependsOnDelegationIds || []).length > 0), 'overflow independent work is deferred behind a capacity gate');

  const malformedDecision = parseSupervisorDecision(JSON.stringify({
    action: 'execute',
    delegations: [
      { id: 'self-reference', role: 'researcher', objective: 'Self reference', requiredCapabilities: [], dependsOnDelegationIds: ['self-reference'] },
      { id: 'missing-reference', role: 'researcher', objective: 'Missing reference', requiredCapabilities: [], dependsOnDelegationIds: ['not-present'] },
    ],
  }), 'turn-malformed');
  assert(
    malformedDecision?.delegations?.[0]?.dependsOnDelegationIds?.[0] === 'self-reference'
      && malformedDecision.delegations[1]?.dependsOnDelegationIds?.[0] === 'not-present',
    'parser preserves self and missing dependency references for validation',
  );
  const assertInvalidGraph = (
    delegations: NonNullable<Parameters<typeof decisionToTaskPlan>[0]['delegations']>,
    pattern: RegExp,
    message: string,
  ) => {
    let error: unknown;
    try {
      decisionToTaskPlan({ turnId: 'turn-invalid', action: 'execute', delegations });
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof Error && pattern.test(error.message), message);
  };
  assertInvalidGraph(
    malformedDecision?.delegations || [],
    /cannot depend on itself/,
    'validator reports a preserved parsed self dependency',
  );
  assertInvalidGraph(
    (malformedDecision?.delegations || []).slice(1),
    /depends on missing delegation "not-present"/,
    'validator reports a preserved parsed missing dependency',
  );

  const planOnly = decisionToTaskPlan({
    turnId: 'turn-plan',
    action: 'plan_only',
    response: 'plan only',
    delegations: [
      { id: 'builder', role: 'builder', objective: 'Refactor scanner', requiredCapabilities: ['implementation'] },
    ],
  });
  assert(planOnly.length === 3, 'plan-only Builder lane includes Builder, Reviewer and QA');
  assert(planOnly[0]?.role === 'builder' && planOnly[1]?.role === 'reviewer' && planOnly[2]?.role === 'qa', 'plan-only quality lane order is deterministic');
  assert(planOnly[1]?.dependsOnIndices?.[0] === 0, 'Reviewer depends on Builder in plan-only graph');
  assert(planOnly[2]?.dependsOnIndices?.[0] === 1, 'QA depends on Reviewer in plan-only graph');

  const builderOnlyExecute = decisionToTaskPlan({
    turnId: 'turn-builder-only',
    action: 'execute',
    delegations: [
      { id: 'builder-only', role: 'builder', objective: 'Apply the requested change', requiredCapabilities: ['implementation'] },
    ],
  });
  assert(!builderOnlyExecute.some((task) => task.role === 'researcher'), 'execute keeps Researcher optional when it is not delegated');

  const misclassifiedImplementation = normalizeSupervisorDecision({
    turnId: 'turn-misclassified-implementation',
    action: 'delegate',
    delegations: [{ id: 'inspect', role: 'researcher', objective: 'Inspect the affected code', requiredCapabilities: ['research'] }],
  }, {
    turnId: 'turn-misclassified-implementation',
    userMessage: 'Implement the fix and update the tests.',
    conversationContext: '',
    workspaceContext: '',
  });
  assert(misclassifiedImplementation.action === 'execute', 'explicit implementation intent cannot terminate as a read-only delegate turn');
  assert(
    misclassifiedImplementation.delegations?.map((item) => item.role).join(',') === 'researcher,builder'
      && misclassifiedImplementation.delegations[1]?.dependsOnDelegationIds?.[0] === 'inspect',
    'delegate normalization retains Researcher evidence and injects a dependent Builder',
  );

  const researchOnly = normalizeSupervisorDecision({
    turnId: 'turn-research-only',
    action: 'delegate',
    delegations: [{ id: 'research', role: 'researcher', objective: 'Research implementation options', requiredCapabilities: ['research'] }],
  }, {
    turnId: 'turn-research-only',
    userMessage: 'Research only how we could implement this; do not implement it.',
    conversationContext: '',
    workspaceContext: '',
  });
  assert(researchOnly.action === 'delegate', 'genuine research-only intent remains read-only delegation');

  const explicitResearchAgent = normalizeSupervisorDecision({
    turnId: 'turn-explicit-research-agent',
    action: 'delegate',
    delegations: [{ id: 'research', role: 'researcher', objective: 'Research the options', requiredCapabilities: ['research'] }],
  }, {
    turnId: 'turn-explicit-research-agent',
    userMessage: 'Research the available options.',
    conversationContext: '',
    workspaceContext: '',
    explicitCommand: 'agent',
    explicitTargetRole: 'researcher',
  });
  assert(explicitResearchAgent.action === 'delegate' && explicitResearchAgent.delegations?.every((item) => item.role !== 'builder') === true,
    'agent command with an explicit Researcher target remains read-only delegation');

  const implementationResearchAgent = normalizeSupervisorDecision({
    turnId: 'turn-implementation-research-agent', action: 'delegate',
    delegations: [{ id: 'research', role: 'researcher', objective: 'Research implementation options', requiredCapabilities: ['research'] }],
  }, {
    turnId: 'turn-implementation-research-agent', userMessage: 'Research how to implement cache invalidation in this code.',
    conversationContext: '', workspaceContext: '', explicitCommand: 'agent', explicitTargetRole: 'researcher',
  });
  assert(implementationResearchAgent.action === 'delegate' && implementationResearchAgent.delegations?.every((item) => item.role !== 'builder') === true,
    'research wording about implementation and code does not independently request writes');

  const explicitNonBuilderAgent = normalizeSupervisorDecision({
    turnId: 'turn-explicit-reviewer-agent',
    action: 'delegate',
    delegations: [{ id: 'review', role: 'reviewer', objective: 'Review the proposed behavior', requiredCapabilities: ['review'] }],
  }, {
    turnId: 'turn-explicit-reviewer-agent',
    userMessage: 'Review only the proposed behavior; do not change code.',
    conversationContext: '',
    workspaceContext: '',
    explicitCommand: 'agent',
    explicitTargetRole: 'reviewer',
  });
  assert(explicitNonBuilderAgent.action === 'delegate' && explicitNonBuilderAgent.delegations?.every((item) => item.role !== 'builder') === true,
    'agent command with an explicit non-Builder target does not imply implementation');

  const explicitResearchWrite = normalizeSupervisorDecision({
    turnId: 'turn-explicit-research-write',
    action: 'delegate',
    delegations: [{ id: 'research', role: 'researcher', objective: 'Inspect the defect', requiredCapabilities: ['research'] }],
  }, {
    turnId: 'turn-explicit-research-write',
    userMessage: 'Inspect the defect, then fix the code and update the tests.',
    conversationContext: '',
    workspaceContext: '',
    explicitCommand: 'agent',
    explicitTargetRole: 'researcher',
  });
  assert(explicitResearchWrite.action === 'execute' && explicitResearchWrite.delegations?.some((item) => item.role === 'builder') === true,
    'independent textual write intent can promote an explicit non-Builder agent request');

  const explicitBuilderResearchWording = normalizeSupervisorDecision({
    turnId: 'turn-explicit-builder', action: 'delegate',
    delegations: [{ id: 'research', role: 'researcher', objective: 'Research the options', requiredCapabilities: ['research'] }],
  }, {
    turnId: 'turn-explicit-builder', userMessage: 'Research the options.', conversationContext: '', workspaceContext: '',
    explicitCommand: 'agent', explicitTargetRole: 'builder',
  });
  assert(explicitBuilderResearchWording.action === 'execute' && explicitBuilderResearchWording.delegations?.some((item) => item.role === 'builder') === true,
    'explicit Builder target takes precedence for implementation');

  const reusedResearch = normalizeSupervisorDecision({
    turnId: 'turn-build-follow-up',
    action: 'execute',
    delegations: [{ id: 'build', role: 'builder', objective: 'Build the researched option', requiredCapabilities: ['implementation'] }],
  }, {
    turnId: 'turn-build-follow-up',
    userMessage: 'Build this.',
    conversationContext: 'Durable prior research context is available.',
    workspaceContext: '',
  }, { reusePriorResearch: true });
  assert(reusedResearch.delegations?.every((item) => item.role !== 'researcher') === true,
    'completed-research build follow-up does not inject a redundant Researcher');
  assert(isPriorResearchImplementationFollowUp({ userMessage: 'Build this.', explicitTargetRole: 'builder' }),
    'deictic implementation follow-up selects durable prior research');
  assert(!isPriorResearchImplementationFollowUp({ userMessage: 'Implement an unrelated billing export.', explicitTargetRole: 'builder' }),
    'unrelated later implementation does not suppress fresh research');

  const parsedTarget = parseSupervisorDecision(JSON.stringify({
    action: 'execute',
    delegations: [{ id: 'builder-target', role: 'builder', objective: 'Create the project', requiredCapabilities: [], targetDescriptor: { kind: 'new_sibling_project', projectName: 'AtrisTask' } }],
  }), 'turn-target');
  const targetPlan = parsedTarget ? decisionToTaskPlan(parsedTarget) : [];
  const plannedTarget = targetPlan[0]?.targetDescriptor;
  const targetRoundTrip = plannedTarget?.kind === 'new_sibling_project'
    ? plannedTarget.projectName === 'AtrisTask'
    : false;
  assert(targetRoundTrip, 'planner target metadata round-trips through parser and structured task planning');
  const unsafeParsedTarget = parseSupervisorDecision(JSON.stringify({
    action: 'execute',
    delegations: [{ id: 'builder-unsafe', role: 'builder', objective: 'Escape', requiredCapabilities: [], targetDescriptor: { kind: 'new_sibling_project', projectName: '../escape' } }],
  }), 'turn-unsafe-target');
  assert(unsafeParsedTarget?.delegations?.[0]?.targetDescriptor === undefined, 'unsafe model target metadata is discarded instead of becoming a path');
  assert(inferExplicitBuilderTarget('Create a brand-new AtrisTask project under this workspace')?.projectName === 'AtrisTask', 'explicit new sibling wording deterministically extracts AtrisTask');
  assert(inferExplicitBuilderTarget('AtrisTask klasörü içine kurulacak')?.projectName === 'AtrisTask', 'Turkish new sibling wording deterministically extracts AtrisTask');
  assert(inferExplicitBuilderTarget('Create a new AtrisTask folder')?.projectName === 'AtrisTask', 'English new sibling wording does not require an explicit workspace suffix');
  let unsafeExplicitTargetError = '';
  try {
    normalizeSupervisorDecision({
      turnId: 'turn-explicit-unsafe', action: 'execute',
      delegations: [{ id: 'builder-explicit-unsafe', role: 'builder', objective: 'Create unsafe project', requiredCapabilities: [] }],
    }, { turnId: 'turn-explicit-unsafe', userMessage: 'Create a new ../escape project under this workspace', conversationContext: '', workspaceContext: '' }, { reusePriorResearch: true });
  } catch (error) {
    unsafeExplicitTargetError = error instanceof Error ? error.message : String(error);
  }
  assert(unsafeExplicitTargetError.includes('missing or unsafe'), 'explicit unsafe new sibling wording fails before Builder dispatch');
  let ambiguousTurkishTargetError = '';
  try {
    normalizeSupervisorDecision({
      turnId: 'turn-explicit-ambiguous-tr', action: 'execute',
      delegations: [{ id: 'builder-explicit-ambiguous-tr', role: 'builder', objective: 'Kur', requiredCapabilities: [] }],
    }, { turnId: 'turn-explicit-ambiguous-tr', userMessage: 'Yeni klasör içine kurulacak', conversationContext: '', workspaceContext: '' }, { reusePriorResearch: true });
  } catch (error) {
    ambiguousTurkishTargetError = error instanceof Error ? error.message : String(error);
  }
  assert(ambiguousTurkishTargetError.includes('missing or unsafe'), 'ambiguous Turkish new sibling wording fails before Builder dispatch');
  const duplicateTarget = normalizeSupervisorDecision({
    turnId: 'turn-duplicate-target', action: 'execute', delegations: [
      { id: 'build-a', role: 'builder', objective: 'Create A', requiredCapabilities: [] },
      { id: 'build-b', role: 'builder', objective: 'Create B', requiredCapabilities: [] },
    ],
  }, { turnId: 'turn-duplicate-target', userMessage: 'Create a new AtrisTask folder under this workspace', conversationContext: '', workspaceContext: '' }, { reusePriorResearch: true });
  assert(duplicateTarget.delegations?.filter((item) => item.role === 'builder').length === 1, 'duplicate Builder lanes for one explicit new sibling target collapse before dispatch');

  const reordered = decisionToTaskPlan({
    turnId: 'turn-dependencies',
    action: 'execute',
    delegations: [
      {
        id: 'builder',
        role: 'builder',
        objective: 'Build the selected approach',
        requiredCapabilities: ['implementation'],
        dependsOnDelegationIds: ['researcher'],
      },
      {
        id: 'researcher',
        role: 'researcher',
        objective: 'Research the selected approach',
        requiredCapabilities: ['research'],
      },
    ],
  });
  assert(reordered[0]?.role === 'researcher' && reordered[1]?.role === 'builder', 'dependency graph places Researcher before listed-before dependency Builder');
  assert(reordered[1]?.dependsOnIndices?.[0] === 0, 'remaps Builder dependency to the topologically ordered Researcher index');
  assert(reordered[2]?.dependsOnIndices?.[0] === 1 && reordered[3]?.dependsOnIndices?.[0] === 2, 'preserves generated review and QA dependency chain after reordering');

  const collisionSafe = decisionToTaskPlan({
    turnId: 'turn-generated-id-collision',
    action: 'execute',
    delegations: [
      { id: 'review-b1', role: 'researcher', objective: 'Research review constraints', requiredCapabilities: ['research'] },
      { id: 'qa-b1', role: 'researcher', objective: 'Research QA constraints', requiredCapabilities: ['research'] },
      {
        id: 'b1',
        role: 'builder',
        objective: 'Build with the researched constraints',
        requiredCapabilities: ['implementation'],
        dependsOnDelegationIds: ['review-b1', 'qa-b1'],
      },
    ],
  });
  assert(
    collisionSafe.length === 5
      && collisionSafe[0]?.role === 'researcher'
      && collisionSafe[1]?.role === 'researcher'
      && collisionSafe[2]?.role === 'builder'
      && collisionSafe[3]?.role === 'reviewer'
      && collisionSafe[4]?.role === 'qa',
    'generated Reviewer and QA IDs stay unique when model IDs use their normal names',
  );
  assert(
    collisionSafe[2]?.dependsOnIndices?.join(',') === '0,1'
      && collisionSafe[3]?.dependsOnIndices?.join(',') === '2'
      && collisionSafe[4]?.dependsOnIndices?.join(',') === '3',
    'collision-safe generated dependencies remain uniquely mapped and topological',
  );

  const independent = decisionToTaskPlan({
    turnId: 'turn-independent',
    action: 'execute',
    delegations: [
      { id: 'first', role: 'researcher', objective: 'First independent check', requiredCapabilities: [] },
      { id: 'second', role: 'researcher', objective: 'Second independent check', requiredCapabilities: [] },
      { id: 'third', role: 'researcher', objective: 'Third independent check', requiredCapabilities: [] },
    ],
  });
  const independentAgain = decisionToTaskPlan({
    turnId: 'turn-independent-again',
    action: 'execute',
    delegations: [
      { id: 'first', role: 'researcher', objective: 'First independent check', requiredCapabilities: [] },
      { id: 'second', role: 'researcher', objective: 'Second independent check', requiredCapabilities: [] },
      { id: 'third', role: 'researcher', objective: 'Third independent check', requiredCapabilities: [] },
    ],
  });
  assert(independent.map((task) => task.description).join('|') === 'First independent check|Second independent check|Third independent check', 'independent delegations retain input order');
  assert(independent.map((task) => task.title).join('|') === independentAgain.map((task) => task.title).join('|'), 'independent delegation ordering is stable across planning runs');

  assertInvalidGraph(
    [{ id: 'self', role: 'researcher', objective: 'Self dependency', requiredCapabilities: [], dependsOnDelegationIds: ['self'] }],
    /cannot depend on itself/,
    'rejects self dependencies with a clear error',
  );
  assertInvalidGraph(
    [{ id: 'missing-parent', role: 'researcher', objective: 'Missing dependency', requiredCapabilities: [], dependsOnDelegationIds: ['missing'] }],
    /depends on missing delegation "missing"/,
    'rejects missing dependencies with a clear error',
  );
  assertInvalidGraph(
    [
      { id: 'cycle-a', role: 'researcher', objective: 'Cycle A', requiredCapabilities: [], dependsOnDelegationIds: ['cycle-b'] },
      { id: 'cycle-b', role: 'researcher', objective: 'Cycle B', requiredCapabilities: [], dependsOnDelegationIds: ['cycle-a'] },
    ],
    /cyclic dependencies prevent ordering.*cycle-a, cycle-b/,
    'rejects cyclic dependencies deterministically with the unresolved IDs',
  );

  for (const action of ['execute', 'plan_only'] as const) {
    const qualityInteraction = parseSupervisorDecision(JSON.stringify({
      action,
      delegations: [
        { id: 'review-root', role: 'reviewer', objective: 'Review existing context', requiredCapabilities: [] },
        { id: 'qa-root', role: 'qa', objective: 'Validate existing context', requiredCapabilities: [] },
        { id: 'research-1', role: 'researcher', objective: 'Research one', requiredCapabilities: [] },
        { id: 'research-2', role: 'researcher', objective: 'Research two', requiredCapabilities: [] },
        { id: 'research-3', role: 'researcher', objective: 'Research three', requiredCapabilities: [] },
        { id: 'builder-1', role: 'builder', objective: 'Build one', requiredCapabilities: [] },
        { id: 'builder-2', role: 'builder', objective: 'Build two', requiredCapabilities: [] },
      ],
    }), `turn-quality-${action}`);
    const retainedDelegations = (qualityInteraction?.delegations || []).filter((item) => item.role !== 'reviewer' && item.role !== 'qa');
    assert(
      retainedDelegations.every((item) => !(item.dependsOnDelegationIds || []).some((id) => id === 'review-root' || id === 'qa-root')),
      `${action} capacity gates do not target removed quality delegations`,
    );
    const qualityPlan = qualityInteraction ? decisionToTaskPlan(qualityInteraction) : [];
    assert(
      qualityPlan.length === 9 && qualityPlan.every((task, index) => (task.dependsOnIndices || []).every((dependencyIndex) => dependencyIndex < index)),
      `${action} quality normalization leaves a valid topologically ordered plan`,
    );
  }

  console.log(`--- Supervisor Turn Policy Tests Complete: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exitCode = 1;
}

runTests();
