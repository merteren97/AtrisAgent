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

  console.log(`--- Supervisor Turn Policy Tests Complete: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exitCode = 1;
}

runTests();
