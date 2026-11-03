/** Codex native presets combine sandbox, approval policy and reviewer. */
export const CODEX_PERMISSION_MODES = ['ask-for-approval', 'approve-for-me', 'full-access', 'read-only'] as const;
export type CodexPermissionMode = typeof CODEX_PERMISSION_MODES[number];
