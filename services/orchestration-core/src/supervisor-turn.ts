import type {
  OrchestratorDecision,
  OrchestratorDelegation,
  OrchestratorTurnAction,
} from '@atris-agent-code/domain';
import type { StructuredTaskPlan } from './orchestrator';

const ACTIONS = new Set<OrchestratorTurnAction>(['respond', 'clarify', 'delegate', 'execute', 'plan_only']);
const WORKER_ROLES = new Set<OrchestratorDelegation['role']>(['researcher', 'builder', 'reviewer', 'qa']);

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

function normalizeDelegations(value: unknown): OrchestratorDelegation[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: OrchestratorDelegation[] = [];
  for (let index = 0; index < value.length && result.length < 12; index += 1) {
    const item = value[index];
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const role = String(record.role || '').toLowerCase() as OrchestratorDelegation['role'];
    if (!WORKER_ROLES.has(role)) continue;
    let id = String(record.id || `${role}-${index + 1}`).trim();
    if (!id || seen.has(id)) id = `${role}-${index + 1}-${crypto.randomUUID().slice(0, 6)}`;
    seen.add(id);
    const objective = String(record.objective || '').trim();
    if (!objective) continue;
    const requiredCapabilities = Array.isArray(record.requiredCapabilities)
      ? record.requiredCapabilities.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 12)
      : [];
    const dependsOnDelegationIds = Array.isArray(record.dependsOnDelegationIds)
      ? record.dependsOnDelegationIds.map(String).map((item) => item.trim()).filter(Boolean)
      : [];
    result.push({
      id,
      role,
      objective,
      requiredCapabilities,
      dependsOnDelegationIds,
      preferredParallelGroup: typeof record.preferredParallelGroup === 'string' ? record.preferredParallelGroup : undefined,
    });
  }
  const validIds = new Set(result.map((item) => item.id));
  return result.map((item) => ({
    ...item,
    dependsOnDelegationIds: (item.dependsOnDelegationIds || []).filter((id) => id !== item.id && validIds.has(id)),
  }));
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
    delegations: normalizeDelegations(parsed.delegations),
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
    '- execute: source changes are requested. Research is optional. Builders may be parallel only for genuinely independent implementation lanes. Every Builder lane must be reviewable and testable.',
    '- plan_only: the user explicitly asks to create/show a plan without beginning execution.',
    '',
    'Important behavior:',
    '- Interpret short follow-ups such as "devam edelim", "2. yöntemi uygula", "öncekini boşver" from conversation context instead of treating them as new isolated requests.',
    '- Prefer a direct response when the existing context already answers the user.',
    '- Do not force Researcher -> Builder -> Reviewer for every turn.',
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
      delegations: [{ id: 'builder-1', role: 'builder', objective: context.userMessage, requiredCapabilities: ['implementation'] }],
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

/**
 * Normalizes model delegations into a runtime-safe task graph.
 * Builder lanes are isolated. Each lane gets its own Reviewer and QA dependency,
 * which keeps multi-Builder execution compatible with worktree-local review/QA.
 */
export function decisionToTaskPlan(decision: OrchestratorDecision): StructuredTaskPlan[] {
  let delegations = [...(decision.delegations || [])];
  if (decision.action === 'delegate') {
    delegations = delegations.filter((item) => item.role !== 'builder');
  }

  if (decision.action === 'execute') {
    const builders = delegations.filter((item) => item.role === 'builder');
    const nonQuality = delegations.filter((item) => item.role !== 'reviewer' && item.role !== 'qa');
    delegations = [...nonQuality];
    for (const builder of builders) {
      const reviewerId = `review-${builder.id}`;
      const qaId = `qa-${builder.id}`;
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

  const idToIndex = new Map(delegations.map((item, index) => [item.id, index]));
  return delegations.map((item) => ({
    title: `${item.role.charAt(0).toUpperCase() + item.role.slice(1)}: ${item.objective}`,
    description: item.objective,
    role: item.role,
    priority: item.role === 'builder' || item.role === 'reviewer' || item.role === 'qa' ? 'high' : 'medium',
    requiredCapabilities: item.requiredCapabilities.length
      ? item.requiredCapabilities
      : item.role === 'builder'
        ? ['write_to_file', 'replace_file_content', 'run_command']
        : ['read_file', 'grep_search', 'view_file'],
    dependsOnIndices: (item.dependsOnDelegationIds || [])
      .map((id) => idToIndex.get(id))
      .filter((index): index is number => index !== undefined),
  }));
}
