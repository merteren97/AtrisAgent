import type { RuntimeType, CodexPermissionMode } from '@atris-agent-code/domain';

export interface PlanningConversation {
  id: string; title: string; workspaceId: string; planId: string;
  runtimeType: RuntimeType; catalogId: string; model: string; accountProfileId: string;
  reasoning?: string; createdAt: string; updatedAt: string; closedAt: string | null;
  codexPermissionMode: CodexPermissionMode; openCodeAutoApprove: boolean;
  /** Original create body fingerprint, retained across configuration changes. */
  creationFingerprint?: string;
}
export const CONVERSATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateConversations(value: unknown, workspaceId: string, planId: string): PlanningConversation[] {
  const invalid = () => { throw Object.assign(new Error('Invalid planning conversation registry; existing data was preserved.'), { statusCode: 409 }); };
  if (!Array.isArray(value) || value.length > 2000) return invalid();
  const ids = new Set<string>();
  for (const item of value as PlanningConversation[]) {
    if (!item || (item.id !== 'default' && !CONVERSATION_UUID.test(item.id)) || ids.has(item.id.toLowerCase()) || item.id !== item.id.toLowerCase()
      || item.workspaceId !== workspaceId || item.planId !== planId
      || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200 || /[\x00-\x1f\x7f]/.test(item.title)
      || !['codex', 'opencode', 'claude_code', 'antigravity'].includes(item.runtimeType)
      || !['catalogId', 'model', 'accountProfileId'].every(key => { const value = item[key as keyof PlanningConversation]; return typeof value === 'string' && value.length <= 512 && (item.id === 'default' || Boolean(value.trim())); })
      || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt))
      || (item.closedAt !== null && (typeof item.closedAt !== 'string' || !Number.isFinite(Date.parse(item.closedAt))))
      || (item.reasoning !== undefined && (typeof item.reasoning !== 'string' || item.reasoning.length > 32))
      || !['read-only', 'ask-for-approval', 'approve-for-me', 'full-access'].includes(item.codexPermissionMode)
      || typeof item.openCodeAutoApprove !== 'boolean'
      || (item.runtimeType !== 'opencode' && item.openCodeAutoApprove)
      || (item.runtimeType !== 'codex' && item.codexPermissionMode !== 'read-only')
      || (item.creationFingerprint !== undefined && (typeof item.creationFingerprint !== 'string' || item.creationFingerprint.length > 2000))) return invalid();
    ids.add(item.id.toLowerCase());
  }
  return value as PlanningConversation[];
}
