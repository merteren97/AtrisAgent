import { CODEX_PERMISSION_MODES, type CodexPermissionMode } from '@atris-agent-code/domain';

export function isCodexPermissionMode(value: unknown): value is CodexPermissionMode {
  return CODEX_PERMISSION_MODES.includes(value as CodexPermissionMode);
}

/** Explicit argv also overrides saved resume settings. Never alter shared user config. */
export function codexPermissionArgs(mode?: CodexPermissionMode): string[] {
  if (mode === undefined) return [];
  if (!isCodexPermissionMode(mode)) throw new Error('Invalid Codex permission mode.');
  const sandbox = mode === 'read-only' ? 'read-only' : mode === 'full-access' ? 'danger-full-access' : 'workspace-write';
  return ['--sandbox', sandbox, '--ask-for-approval', mode === 'full-access' ? 'never' : 'on-request',
    '-c', `approvals_reviewer="${mode === 'approve-for-me' ? 'auto_review' : 'user'}"`];
}
