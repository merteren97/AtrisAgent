export type Provider = 'openai' | 'anthropic' | 'google' | 'local' | 'opencode' | 'codex' | 'antigravity';
export type RuntimeType = 'codex' | 'claude_code' | 'antigravity' | 'opencode';

export type AccountProfileStatus =
  | 'not_installed'
  | 'login_required'
  | 'awaiting_browser'
  | 'awaiting_device_code'
  | 'connected'
  | 'expiring'
  | 'rate_limited'
  | 'reauth_required'
  | 'disabled'
  | 'error';

export type AuthStatus = AccountProfileStatus;
export type RuntimeProfileMode = 'isolated' | 'shared_cli';

export interface AccountProfile {
  id: string;
  provider: Provider;
  runtimeType: RuntimeType;
  profileName: string;
  authStatus: AccountProfileStatus;
  /** Non-secret configuration root used to isolate supported CLIs. */
  configDir: string;
  supportedModels: string[];
  usageScope: string | null;
  createdAt: string;
  updatedAt: string;
  emailOrOrg?: string;
  allowedRoles?: string[];
  schedulerAuto?: boolean;
  remainingQuota?: string;
  executablePath?: string;
  installedVersion?: string;
  integrationMode?: string;
  authMethod?: string;
  loginUrl?: string;
  deviceCode?: string;
  lastVerifiedAt?: string;
  lastModelDiscoveryAt?: string;
  capabilitySnapshot?: Record<string, boolean>;
  statusMessage?: string;
  /** Whether AtrisAgent uses an isolated profile root or attaches to the user's existing CLI configuration. */
  profileMode?: RuntimeProfileMode;
}

export interface RuntimeAdapterCapabilities {
  liveSteer: boolean;
  interactiveApproval: boolean;
  sessionResume: boolean;
  reuseWhileAlive: boolean;
  nativeAttachments: boolean;
}

export interface RuntimeStatus {
  runtimeType: RuntimeType;
  name: string;
  installation: {
    installed: boolean;
    path?: string;
    version?: string;
    error?: string;
  };
  capabilities: Record<string, boolean>;
  adapterCapabilities?: RuntimeAdapterCapabilities;
  authMethods: Array<{
    id: string;
    name: string;
    type: string;
    description?: string;
  }>;
}

/**
 * Zero-config local CLI readiness: profiles with empty or omitted allowedRoles
 * are permitted across all security roles without manual role checkboxes.
 */
export function isRoleAllowedByProfile(
  profile: Pick<AccountProfile, 'allowedRoles'>,
  role: string,
): boolean {
  if (!profile.allowedRoles || profile.allowedRoles.length === 0) return true;
  const target = role.trim().toLowerCase();
  return profile.allowedRoles.some((allowed) => allowed.trim().toLowerCase() === target);
}
