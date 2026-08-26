export type ExecutionMode = 'review_driven' | 'balanced' | 'autonomous' | 'custom' | 'candidate';
export type ApprovalPolicy = 'always' | 'risk_based' | 'never';
export type ActionPolicy = 'ask' | 'automatic';
export type ExtendedActionPolicy = 'ask' | 'allowlisted' | 'automatic';
export type ApplyPolicy = 'user_decides' | 'orchestrator_decides' | 'automatic';
export type PushPolicy = 'never' | 'ask' | 'automatic';
export type DeletePolicy = 'ask' | 'risk_based' | 'automatic';
export type TrustProfile = 'ask' | 'review' | 'auto';
export type AutomationDecision = 'ask' | 'review' | 'auto' | 'deny';
export type AutomationAction = 'plan' | 'fileWrite' | 'deleteFiles' | 'commandExecution' | 'packageInstall'
  | 'gitCommit' | 'databaseMigration' | 'workspaceApply' | 'gitPush' | 'pullRequest';

const PROFILE_ACTIONS: Record<TrustProfile, Record<AutomationAction, AutomationDecision>> = {
  ask: { plan: 'ask', fileWrite: 'ask', deleteFiles: 'ask', commandExecution: 'ask', packageInstall: 'ask', gitCommit: 'ask', databaseMigration: 'ask', workspaceApply: 'ask', gitPush: 'ask', pullRequest: 'ask' },
  review: { plan: 'auto', fileWrite: 'review', deleteFiles: 'review', commandExecution: 'review', packageInstall: 'review', gitCommit: 'review', databaseMigration: 'ask', workspaceApply: 'review', gitPush: 'ask', pullRequest: 'review' },
  auto: { plan: 'auto', fileWrite: 'auto', deleteFiles: 'auto', commandExecution: 'auto', packageInstall: 'auto', gitCommit: 'auto', databaseMigration: 'review', workspaceApply: 'auto', gitPush: 'ask', pullRequest: 'auto' },
};

export function resolveAutomationAction(profile: TrustProfile, action: AutomationAction, overrides: Partial<Record<AutomationAction, AutomationDecision>> = {}): AutomationDecision {
  return overrides[action] || PROFILE_ACTIONS[profile]?.[action] || 'deny';
}

export interface PolicyConfig {
  executionMode: ExecutionMode;
  planApproval: ApprovalPolicy;
  fileWrite: ActionPolicy;
  gitCommit: ActionPolicy;
  applyToWorkspace: ApplyPolicy;
  packageInstall: ExtendedActionPolicy;
  databaseMigration: ActionPolicy;
  gitPush: PushPolicy;
  pullRequest: ActionPolicy;
  deleteFiles: DeletePolicy;
  commandDenylist?: string[];
  commandPrefixAllowlist?: string[];
  forbiddenPaths?: string[];
  secretRedactionPatterns?: string[];
}

export class PolicyEngine {
  private config: PolicyConfig;
  private commandDenylist: string[];
  private commandPrefixAllowlist: string[];
  private forbiddenPaths: string[];

  constructor(mode: ExecutionMode = 'balanced', overrides?: Partial<PolicyConfig>) {
    this.config = {
      ...PolicyEngine.getDefaultConfig(mode),
      ...overrides,
    };

    this.commandDenylist = this.config.commandDenylist ?? [
      'rm -rf',
      'wget',
      'curl',
      'mkfs',
      'format',
      'dd',
      'chmod 777',
      'sudo',
      'shutdown',
      'reboot',
      'drop database',
      'truncate table',
    ];

    this.commandPrefixAllowlist = this.config.commandPrefixAllowlist ?? [
      'npm',
      'pnpm',
      'yarn',
      'git',
      'node',
      'tsc',
      'npx',
      'cargo',
      'go',
      'pytest',
      'python',
      'bun',
      'deno',
      'echo',
    ];

    this.forbiddenPaths = this.config.forbiddenPaths ?? [
      '.env',
      '.secret',
      '.git/config',
      'id_rsa',
      'id_ed25519',
      '.pem',
      'shadow',
      'passwd',
    ];
  }

  static getDefaultConfig(mode: ExecutionMode): PolicyConfig {
    switch (mode) {
      case 'review_driven':
        return {
          executionMode: 'review_driven',
          planApproval: 'always',
          fileWrite: 'ask',
          gitCommit: 'ask',
          applyToWorkspace: 'user_decides',
          packageInstall: 'ask',
          databaseMigration: 'ask',
          gitPush: 'ask',
          pullRequest: 'ask',
          deleteFiles: 'ask',
        };
      case 'balanced':
      case 'candidate':
        return {
          executionMode: mode,
          planApproval: 'risk_based',
          fileWrite: 'automatic',
          gitCommit: 'automatic',
          applyToWorkspace: 'orchestrator_decides',
          packageInstall: 'allowlisted',
          databaseMigration: 'ask',
          gitPush: 'ask',
          pullRequest: 'ask',
          deleteFiles: 'risk_based',
        };
      case 'autonomous':
        return {
          executionMode: 'autonomous',
          planApproval: 'never',
          fileWrite: 'automatic',
          gitCommit: 'automatic',
          applyToWorkspace: 'automatic',
          packageInstall: 'automatic',
          databaseMigration: 'automatic',
          gitPush: 'ask',
          pullRequest: 'automatic',
          deleteFiles: 'automatic',
        };
      case 'custom':
      default:
        return PolicyEngine.getDefaultConfig('balanced');
    }
  }

  getConfig(): PolicyConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<PolicyConfig>): void {
    this.config = { ...this.config, ...partial };
    if (partial.commandDenylist) this.commandDenylist = partial.commandDenylist;
    if (partial.commandPrefixAllowlist) this.commandPrefixAllowlist = partial.commandPrefixAllowlist;
    if (partial.forbiddenPaths) this.forbiddenPaths = partial.forbiddenPaths;
  }

  /**
   * Determine whether an agent role can execute a given tool.
   */
  canExecuteTool(agentRole: string, toolName: string): boolean {
    const role = agentRole.trim().toLowerCase();
    const tool = toolName.trim().toLowerCase().replace(/[.\s-]+/g, '_');
    const writeMarkers = ['write', 'edit', 'replace', 'patch', 'delete', 'remove', 'move', 'rename', 'apply'];
    const shellMarkers = ['shell', 'terminal', 'command', 'exec', 'spawn'];
    const releaseMarkers = ['commit', 'push', 'pull_request', 'publish', 'deploy', 'migration', 'package_install'];
    const containsAny = (markers: string[]) => markers.some((marker) => tool.includes(marker));

    if (role === 'builder') return true;
    if (role === 'qa') {
      return !containsAny(writeMarkers) && !containsAny(releaseMarkers);
    }
    if (role === 'orchestrator' || role === 'reviewer' || role === 'researcher') {
      return !containsAny(writeMarkers) && !containsAny(shellMarkers) && !containsAny(releaseMarkers);
    }
    // Unknown roles default to least privilege instead of inheriting Builder access.
    return !containsAny(writeMarkers) && !containsAny(shellMarkers) && !containsAny(releaseMarkers);
  }

  /**
   * Validate target path for path traversal, forbidden sensitive files, and workspace boundaries.
   */
  validatePath(targetPath: string, workspacePath?: string): { allowed: boolean; reason?: string } {
    if (!targetPath) return { allowed: true };

    const normalized = targetPath.trim().replace(/\\/g, '/');

    // Path traversal check
    if (normalized.includes('../') || normalized.includes('/..') || normalized === '..') {
      return { allowed: false, reason: `Path traversal attempt blocked: ${targetPath}` };
    }

    // Forbidden sensitive files check
    const lowerPath = normalized.toLowerCase();
    for (const forbidden of this.forbiddenPaths) {
      const lowerForbidden = forbidden.toLowerCase();
      if (lowerPath.endsWith(lowerForbidden) || lowerPath.includes(`/${lowerForbidden}`)) {
        return { allowed: false, reason: `Access to sensitive file blocked: ${targetPath}` };
      }
    }

    // Workspace boundary check
    if (workspacePath) {
      const normalizeComparable = (value: string): string => {
        const normalizedValue = path.posix.normalize(value.replace(/\\/g, '/'));
        return normalizedValue.length > 1 && normalizedValue.endsWith('/')
          ? normalizedValue.slice(0, -1).toLowerCase()
          : normalizedValue.toLowerCase();
      };
      const normWorkspace = normalizeComparable(workspacePath);
      const normTarget = normalizeComparable(normalized);

      const isAbsolute = normTarget.startsWith('/') || /^[a-z]:\//i.test(normTarget);
      const targetWithinWorkspace = isAbsolute
        ? normTarget === normWorkspace || normTarget.startsWith(`${normWorkspace}/`)
        : normalizeComparable(`${normWorkspace}/${normTarget}`) === normWorkspace
          || normalizeComparable(`${normWorkspace}/${normTarget}`).startsWith(`${normWorkspace}/`);
      if (!targetWithinWorkspace) {
        return { allowed: false, reason: `Path outside workspace boundary blocked: ${targetPath}` };
      }

      // Lexical checks do not protect a new path below an existing symlink.
      // Resolve the nearest existing parent when both paths are on disk.
      try {
        if (fs.existsSync(workspacePath)) {
          const realPathWithExistingParent = (value: string): string | undefined => {
            let cursor = path.resolve(value);
            const missing: string[] = [];
            while (!fs.existsSync(cursor)) {
              const parent = path.dirname(cursor);
              if (parent === cursor) return undefined;
              missing.unshift(path.basename(cursor));
              cursor = parent;
            }
            let resolved = fs.realpathSync.native(cursor);
            for (const segment of missing) resolved = path.join(resolved, segment);
            return resolved;
          };
          const physicalRoot = realPathWithExistingParent(workspacePath);
          const physicalTarget = realPathWithExistingParent(
            isAbsolute ? normalized : path.join(workspacePath, normalized),
          );
          if (!physicalRoot || !physicalTarget) return { allowed: true };
          const root = normalizeComparable(physicalRoot);
          const target = normalizeComparable(physicalTarget);
          if (target !== root && !target.startsWith(`${root}/`)) {
            return { allowed: false, reason: `Path escapes workspace through a symlink: ${targetPath}` };
          }
        }
      } catch {
        // A not-yet-created file is covered by the lexical boundary check.
      }
    }

    return { allowed: true };
  }

  /**
   * Convenience boolean helper for path validation.
   */
  isPathAllowed(targetPath: string, workspacePath?: string): boolean {
    return this.validatePath(targetPath, workspacePath).allowed;
  }

  /**
   * Validate command against denylist and allowlist rules.
   */
  validateCommand(command: string): { allowed: boolean; reason?: string } {
    if (!command) return { allowed: true };
    const trimmed = command.trim();
    const lowerCmd = trimmed.toLowerCase();

    // 1. Denylist check
    for (const denied of this.commandDenylist) {
      if (lowerCmd.includes(denied.toLowerCase())) {
        return { allowed: false, reason: `Command execution blocked by denylist (${denied}): ${command}` };
      }
    }

    // 2. Allowlist check if packageInstall policy is allowlisted
    if (this.config.packageInstall === 'allowlisted') {
      const isPackageCmd = lowerCmd.startsWith('npm install') || lowerCmd.startsWith('yarn add') || lowerCmd.startsWith('pnpm add');
      if (isPackageCmd) {
        const allowedPrefixMatch = this.commandPrefixAllowlist.some(prefix => lowerCmd.startsWith(prefix.toLowerCase()));
        if (!allowedPrefixMatch) {
          return { allowed: false, reason: `Command execution blocked by allowlist policy: ${command}` };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Redact sensitive secrets (API keys, OAuth tokens, Auth headers, Private keys) from log text.
   */
  redactSecrets(input: string): string {
    if (!input) return input;
    let redacted = input;

    const patterns: Array<{ regex: RegExp; replacement: string }> = [
      { regex: /Authorization:\s*Bearer\s+[^\s"'\r\n]+/gi, replacement: 'Authorization: Bearer [REDACTED_TOKEN]' },
      { regex: /Authorization:\s*Basic\s+[^\s"'\r\n]+/gi, replacement: 'Authorization: Basic [REDACTED_TOKEN]' },
      { regex: /\b(sk-[a-zA-Z0-9_-]{20,})\b/g, replacement: '[REDACTED_API_KEY]' },
      { regex: /\b(ghp_[a-zA-Z0-9]{30,})\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
      { regex: /\b(gho_[a-zA-Z0-9]{30,})\b/g, replacement: '[REDACTED_OAUTH_TOKEN]' },
      { regex: /\b(xox[baprs]-[a-zA-Z0-9_-]{10,})\b/g, replacement: '[REDACTED_SLACK_TOKEN]' },
      { regex: /(api[_-]?key|secret|token|password|auth_token)\s*[:=]\s*["']?([a-zA-Z0-9_\-\.\~]{8,})["']?/gi, replacement: '$1=[REDACTED]' },
      { regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
    ];

    for (const { regex, replacement } of patterns) {
      redacted = redacted.replace(regex, replacement);
    }

    return redacted;
  }

  /**
   * Deeply redact secrets in objects or arrays.
   */
  redactObject<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') {
      return this.redactSecrets(obj) as unknown as T;
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.redactObject(item)) as unknown as T;
    }
    if (typeof obj === 'object') {
      const result: Record<string, any> = {};
      for (const key of Object.keys(obj as object)) {
        const val = (obj as Record<string, any>)[key];
        const keyLower = key.toLowerCase();
        if (
          keyLower.includes('password') ||
          keyLower.includes('secret') ||
          keyLower.includes('token') ||
          keyLower.includes('apikey') ||
          keyLower.includes('api_key')
        ) {
          result[key] = '[REDACTED]';
        } else {
          result[key] = this.redactObject(val);
        }
      }
      return result as T;
    }
    return obj;
  }

  /**
   * Security permission check for actions, paths, and commands.
   */
  async checkPermission(action: string, context?: { path?: string; command?: string; workspacePath?: string }): Promise<boolean> {
    if (context?.path) {
      const pathResult = this.validatePath(context.path, context.workspacePath);
      if (!pathResult.allowed) {
        console.warn(`[PolicyEngine] ${pathResult.reason}`);
        return false;
      }
    }

    if (context?.command) {
      const cmdResult = this.validateCommand(context.command);
      if (!cmdResult.allowed) {
        console.warn(`[PolicyEngine] ${cmdResult.reason}`);
        return false;
      }
    }

    return true;
  }

  /**
   * Request approval based on PolicyConfig matrix.
   */
  async requestApproval(action: string, description: string): Promise<boolean> {
    const policy = this.getActionPolicy(action);

    switch (policy) {
      case 'automatic':
      case 'never':
        return true;
      case 'ask':
      case 'always':
        return false;
      case 'risk_based':
        return !this.isRiskyAction(action, description);
      case 'allowlisted':
        return this.isAllowlisted(action, description);
      default:
        return false;
    }
  }

  private getActionPolicy(action: string): string {
    switch (action) {
      case 'plan': return this.config.planApproval;
      case 'file_write': return this.config.fileWrite;
      case 'git_commit': return this.config.gitCommit;
      case 'apply': return this.config.applyToWorkspace;
      case 'package_install': return this.config.packageInstall;
      case 'database_migration': return this.config.databaseMigration;
      case 'git_push': return this.config.gitPush;
      case 'pull_request': return this.config.pullRequest;
      case 'delete': return this.config.deleteFiles;
      default: return 'ask';
    }
  }

  private isRiskyAction(action: string, description: string): boolean {
    const riskyPatterns = ['delete', 'drop', 'rm -rf', 'migration', 'push', 'force', 'format', 'system'];
    const lower = description.toLowerCase();
    return riskyPatterns.some(p => lower.includes(p));
  }

  private isAllowlisted(_action: string, _description: string): boolean {
    return false;
  }
}

import fs from 'node:fs';
import path from 'node:path';
