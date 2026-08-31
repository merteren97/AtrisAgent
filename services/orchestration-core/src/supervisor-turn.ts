import type {
  OrchestratorDecision,
  OrchestratorDelegation,
  OrchestratorTurnAction,
} from '@atris-agent-code/domain';
import type { StructuredTaskPlan } from './orchestrator';

const ACTIONS = new Set<OrchestratorTurnAction>(['respond', 'clarify', 'delegate', 'execute', 'plan_only']);
const WORKER_ROLES = new Set<OrchestratorDelegation['role']>(['researcher', 'builder', 'reviewer', 'qa']);
const ROLE_LIMITS: Record<OrchestratorDelegation['role'], number> = {
  researcher: 3,
  builder: 2,
  reviewer: 2,
  qa: 2,
};
const MAX_INITIAL_PARALLEL_DELEGATIONS = 4;

function isRetainedDelegationRole(
  role: OrchestratorDelegation['role'],
  action: OrchestratorTurnAction,
): boolean {
  if (action === 'delegate') return role !== 'builder';
  if (action === 'execute' || action === 'plan_only') return role !== 'reviewer' && role !== 'qa';
  return true;
}

export interface SupervisorTurnContext {
  turnId: string;
  userMessage: string;
  conversationContext: string;
  workspaceContext: string;
  explicitCommand?: string;
  explicitTargetRole?: string;
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.unshift(fenced);
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next extraction form.
    }
  }
  return null;
}

function normalizeDelegations(value: unknown, action: OrchestratorTurnAction): OrchestratorDelegation[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const roleCounts = new Map<OrchestratorDelegation['role'], number>();
  const result: OrchestratorDelegation[] = [];
  for (let index = 0; index < value.length && result.length < 12; index += 1) {
    const item = value[index];
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const role = String(record.role || '').toLowerCase() as OrchestratorDelegation['role'];
    if (!WORKER_ROLES.has(role)) continue;
    const currentRoleCount = roleCounts.get(role) || 0;
    if (currentRoleCount >= ROLE_LIMITS[role]) continue;

    let id = String(record.id || `${role}-${index + 1}`).trim();
    if (!id || seen.has(id)) id = `${role}-${index + 1}-${crypto.randomUUID().slice(0, 6)}`;
    seen.add(id);
    const objective = String(record.objective || '').trim();
    if (!objective) continue;
    const requiredCapabilities = Array.isArray(record.requiredCapabilities)
      ? record.requiredCapabilities.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 12)
      : [];
    const dependsOnDelegationIds = Array.isArray(record.dependsOnDelegationIds)
      ? record.dependsOnDelegationIds.map(String).map((item) => item.trim())
      : [];
    result.push({
      id,
      role,
      objective,
      requiredCapabilities,
      dependsOnDelegationIds,
      preferredParallelGroup: typeof record.preferredParallelGroup === 'string' ? record.preferredParallelGroup : undefined,
    });
    roleCounts.set(role, currentRoleCount + 1);
  }

  // The Phase 1 pool has a global parallel ceiling of four. The legacy execution
  // engine dispatches every zero-dependency root immediately, so encode only the
  // overflow capacity as a scheduler dependency until the V2 allocator fully owns
  // initial dispatch. Semantic dependencies from the model are preserved.
  const initialRoots: string[] = [];
  let overflowIndex = 0;
  return result.map((item) => {
    // Do not point a capacity gate at a delegation that decisionToTaskPlan will remove.
    if (!isRetainedDelegationRole(item.role, action)) return item;
    const dependencies = item.dependsOnDelegationIds || [];
    if (dependencies.length > 0) return item;
    if (initialRoots.length < MAX_INITIAL_PARALLEL_DELEGATIONS) {
      initialRoots.push(item.id);
      return item;
    }
    const capacityGate = initialRoots[overflowIndex % initialRoots.length];
    overflowIndex += 1;
    return { ...item, dependsOnDelegationIds: [capacityGate] };
  });
}

export function parseSupervisorDecision(raw: string, turnId: string): OrchestratorDecision | null {
  const parsed = extractJsonObject(raw);
  if (!parsed) return null;
  const action = String(parsed.action || '').toLowerCase() as OrchestratorTurnAction;
  if (!ACTIONS.has(action)) return null;
  const questions = Array.isArray(parsed.clarifyingQuestions)
    ? parsed.clarifyingQuestions.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 4)
    : [];
  return {
    turnId,
    action,
    response: typeof parsed.response === 'string' ? parsed.response.trim() : undefined,
    clarifyingQuestions: questions,
    delegations: normalizeDelegations(parsed.delegations, action),
    needsUserApproval: Boolean(parsed.needsUserApproval),
  };
}

export function buildSupervisorDecisionPrompt(context: SupervisorTurnContext): string {
  return [
    'You are the persistent AtrisAgent Orchestrator for one project conversation.',
    'You retain control of the conversation. Specialist agents are workers you delegate to; they do not replace you as the user-facing agent.',
    '',
    'Decide what THIS user turn needs. Do not create an execution plan just because a message arrived.',
    'Allowed actions:',
    '- respond: answer directly from the supplied conversation/project context; create no workers and no plan.',
    '- clarify: ask only the minimum blocking question(s); create no workers and no plan.',
    '- delegate: read-only investigation/research/validation. Use 1-3 independent Researchers in parallel when the work naturally splits.',
    '- execute: source changes are requested. Research first is the default for coding or complex execution. Use at most 3 parallel Researchers, then at most 2 Builders for genuinely independent implementation lanes. Every Builder must depend on all Researcher tasks whose evidence it needs and must be reviewable and testable.',
    '- plan_only: the user explicitly asks to create/show a plan without beginning execution; include the intended review/QA path but do not start it.',
    '',
    'Capacity policy: at most 3 Researchers, 2 Builders, 2 Reviewers, 2 QA workers; no more than 4 dependency-free workers may start concurrently.',
    '',
    'Important behavior:',
    '- Interpret short follow-ups such as "devam edelim", "2. yöntemi uygula", "öncekini boşver" from conversation context instead of treating them as new isolated requests.',
    '- Prefer a direct response when the existing context already answers the user.',
    '- Direct response and clarification remain valid for simple turns. Do not create workers when they are unnecessary.',
    '- Split independent research topics into multiple researcher delegations with no dependencies and the same preferredParallelGroup.',
    '- For execute, Builder dependencies should reference only research that is actually required.',
    '- Never invent completed work. If current code/evidence must be inspected, delegate it.',
    '- Keep delegations focused; each objective should be independently understandable.',
    '',
    'Return STRICT JSON only with this shape:',
    '{',
    '  "action": "respond|clarify|delegate|execute|plan_only",',
    '  "response": "user-facing response when action is respond/clarify, otherwise a short intent summary",',
    '  "clarifyingQuestions": ["..."],',
    '  "needsUserApproval": false,',
    '  "delegations": [',
    '    {',
    '      "id": "stable-short-id",',
    '      "role": "researcher|builder|reviewer|qa",',
    '      "objective": "focused objective",',
    '      "requiredCapabilities": ["..."],',
    '      "dependsOnDelegationIds": ["..."],',
    '      "preferredParallelGroup": "optional-group"',
    '    }',
    '  ]',
    '}',
    '',
    `Turn id: ${context.turnId}`,
    `Explicit command: ${context.explicitCommand || '(none)'}`,
    `Explicit target role: ${context.explicitTargetRole || '(none)'}`,
    '',
    'Workspace context:',
    context.workspaceContext || '(workspace context unavailable)',
    '',
    'Conversation context (oldest to newest, compacted):',
    context.conversationContext || '(no earlier conversation context)',
    '',
    'Current user message:',
    context.userMessage,
  ].join('\n');
}

export function fallbackSupervisorDecision(context: SupervisorTurnContext): OrchestratorDecision {
  const text = context.userMessage.toLocaleLowerCase('tr-TR');
  const command = String(context.explicitCommand || '').toLowerCase();
  const targetRole = String(context.explicitTargetRole || '').toLowerCase();
  const planRequested = command === 'plan' || /\b(plan|planla|planlama|plan oluştur|plan yap)\b/i.test(text);
  const implementationRequested = targetRole === 'builder'
    || command === 'agent'
    || /(uygula|implement|düzelt|fix|geliştir|ekle|değiştir|refactor|build|oluştur|kodla)/i.test(text);
  const researchRequested = targetRole === 'researcher'
    || /(araştır|research|analiz|incele|investigate|karşılaştır|compare)/i.test(text);

  if (planRequested) {
    return {
      turnId: context.turnId,
      action: 'plan_only',
      response: 'İsteğin için yürütmeden önce bir plan hazırlıyorum.',
      delegations: implementationRequested
        ? [{ id: 'builder-1', role: 'builder', objective: context.userMessage, requiredCapabilities: ['implementation'] }]
        : [{ id: 'research-1', role: 'researcher', objective: context.userMessage, requiredCapabilities: ['codebase-analysis'] }],
    };
  }
  if (implementationRequested) {
    return {
      turnId: context.turnId,
      action: 'execute',
      response: 'İsteği mevcut konuşma bağlamını koruyarak uygulama çalışmasına dönüştürüyorum.',
      delegations: [
        { id: 'research-1', role: 'researcher', objective: `Inspect the codebase and constraints needed to implement: ${context.userMessage}`, requiredCapabilities: ['research', 'codebase-analysis'] },
        { id: 'builder-1', role: 'builder', objective: context.userMessage, requiredCapabilities: ['implementation'], dependsOnDelegationIds: ['research-1'] },
      ],
    };
  }
  if (researchRequested) {
    return {
      turnId: context.turnId,
      action: 'delegate',
      response: 'İsteği mevcut konuşma bağlamına bağlı bir araştırma çalışması olarak yürütüyorum.',
      delegations: [{ id: 'research-1', role: 'researcher', objective: context.userMessage, requiredCapabilities: ['research', 'codebase-analysis'] }],
    };
  }
  return {
    turnId: context.turnId,
    action: 'clarify',
    response: context.conversationContext
      ? 'Önceki konuşmanın bağlamını koruyorum. Devam ederken hangi bulgu veya öneri üzerinde işlem yapmamı istediğini netleştirir misin?'
      : 'Bu isteği doğrudan yanıtlamam mı, araştırmam mı yoksa projede değişiklik yapmam mı gerektiğini netleştirir misin?',
    clarifyingQuestions: [],
    delegations: [],
  };
}

function topologicallyOrderDelegations(delegations: OrchestratorDelegation[]): OrchestratorDelegation[] {
  const idToInputIndex = new Map<string, number>();
  for (const [index, delegation] of delegations.entries()) {
    if (idToInputIndex.has(delegation.id)) {
      throw new Error(`Invalid delegation dependency graph: duplicate delegation id "${delegation.id}".`);
    }
    idToInputIndex.set(delegation.id, index);
  }

  const remainingDependencyCounts = delegations.map(() => 0);
  const dependentsByInputIndex = delegations.map(() => [] as number[]);
  for (const [index, delegation] of delegations.entries()) {
    const dependencyIds = new Set(delegation.dependsOnDelegationIds || []);
    remainingDependencyCounts[index] = dependencyIds.size;
    for (const dependencyId of dependencyIds) {
      if (dependencyId === delegation.id) {
        throw new Error(`Invalid delegation dependency graph: delegation "${delegation.id}" cannot depend on itself.`);
      }
      const dependencyIndex = idToInputIndex.get(dependencyId);
      if (dependencyIndex === undefined) {
        throw new Error(`Invalid delegation dependency graph: delegation "${delegation.id}" depends on missing delegation "${dependencyId}".`);
      }
      dependentsByInputIndex[dependencyIndex].push(index);
    }
  }

  // Prefer the original input order whenever multiple delegations are ready.
  const ready = delegations
    .map((_, index) => index)
    .filter((index) => remainingDependencyCounts[index] === 0);
  const orderedInputIndices: number[] = [];
  const orderedInputIndexSet = new Set<number>();
  while (ready.length > 0) {
    const currentIndex = ready.shift() as number;
    orderedInputIndices.push(currentIndex);
    orderedInputIndexSet.add(currentIndex);
    for (const dependentIndex of dependentsByInputIndex[currentIndex]) {
      remainingDependencyCounts[dependentIndex] -= 1;
      if (remainingDependencyCounts[dependentIndex] === 0) {
        ready.push(dependentIndex);
        ready.sort((left, right) => left - right);
      }
    }
  }

  if (orderedInputIndices.length !== delegations.length) {
    const unresolvedIds = delegations
      .filter((_, index) => !orderedInputIndexSet.has(index))
      .map((delegation) => delegation.id)
      .join(', ');
    throw new Error(`Invalid delegation dependency graph: cyclic dependencies prevent ordering (unresolved delegations: ${unresolvedIds}).`);
  }

  return orderedInputIndices.map((index) => delegations[index]);
}

function toStructuredTaskPlan(delegations: OrchestratorDelegation[]): StructuredTaskPlan[] {
  const orderedDelegations = topologicallyOrderDelegations(delegations);
  const idToIndex = new Map(orderedDelegations.map((item, index) => [item.id, index]));

  return orderedDelegations.map((item) => ({
    title: `${item.role.charAt(0).toUpperCase() + item.role.slice(1)}: ${item.objective}`,
    description: item.objective,
    role: item.role,
    priority: item.role === 'builder' || item.role === 'reviewer' || item.role === 'qa' ? 'high' : 'medium',
    requiredCapabilities: item.requiredCapabilities.length
      ? item.requiredCapabilities
      : item.role === 'builder'
        ? ['write_to_file', 'replace_file_content', 'run_command']
        : ['read_file', 'grep_search', 'view_file'],
    dependsOnIndices: (item.dependsOnDelegationIds || []).map((id) => {
      const index = idToIndex.get(id);
      if (index === undefined) {
        throw new Error(`Invalid delegation dependency graph: delegation "${item.id}" depends on missing delegation "${id}".`);
      }
      return index;
    }),
  }));
}

/**
 * Normalizes model delegations into a runtime-safe task graph.
 * Builder lanes are isolated. Each lane gets its own Reviewer and QA dependency,
 * which keeps multi-Builder execution compatible with worktree-local review/QA.
 */
export function decisionToTaskPlan(decision: OrchestratorDecision): StructuredTaskPlan[] {
  let delegations = [...(decision.delegations || [])];
  // Validate before action-specific role normalization so malformed references in
  // discarded quality roles cannot silently disappear.
  topologicallyOrderDelegations(delegations);
  const usedDelegationIds = new Set(delegations.map((item) => item.id));
  const allocateGeneratedDelegationId = (baseId: string): string => {
    let candidate = baseId;
    let suffix = 2;
    while (usedDelegationIds.has(candidate)) {
      candidate = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedDelegationIds.add(candidate);
    return candidate;
  };
  if (decision.action === 'delegate') {
    delegations = delegations.filter((item) => isRetainedDelegationRole(item.role, decision.action));
  }

  if (decision.action === 'execute' || decision.action === 'plan_only') {
    const builders = delegations.filter((item) => item.role === 'builder');
    const nonQuality = delegations.filter((item) => isRetainedDelegationRole(item.role, decision.action));
    delegations = [...nonQuality];
    for (const builder of builders) {
      const reviewerId = allocateGeneratedDelegationId(`review-${builder.id}`);
      const qaId = allocateGeneratedDelegationId(`qa-${builder.id}`);
      delegations.push({
        id: reviewerId,
        role: 'reviewer',
        objective: `Review Builder lane "${builder.objective}" against the user request, repository rules, architecture and security constraints.`,
        requiredCapabilities: ['code-review', 'security-review', 'architecture-review'],
        dependsOnDelegationIds: [builder.id],
      });
      delegations.push({
        id: qaId,
        role: 'qa',
        objective: `Validate the reviewed Builder lane "${builder.objective}" with the safest relevant build, tests, lint and static checks.`,
        requiredCapabilities: ['testing', 'build', 'lint', 'validation'],
        dependsOnDelegationIds: [reviewerId],
      });
    }
  }

  return toStructuredTaskPlan(delegations);
}
