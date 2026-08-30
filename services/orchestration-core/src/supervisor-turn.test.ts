import { decisionToTaskPlan, parseSupervisorDecision } from './supervisor-turn';

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
