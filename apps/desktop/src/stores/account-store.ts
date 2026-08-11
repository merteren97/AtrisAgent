import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AccountProfile,
  RuntimeType,
  RuntimeStatus,
  ModelDescriptor,
  CanonicalReasoning,
} from '@atris-agent-code/domain';
import { apiRequest, checkApiHealth } from '@/lib/api-client';

export interface DiscoveredModel {
  id: string;
  catalogId: string;
  runtimeModelId: string;
  name: string;
  description?: string;
  provider: string;
  runtimeType: RuntimeType;
  accountProfileId: string;
  accountName: string;
  available: boolean;
  availability: ModelDescriptor['availability'];
  supportsReasoning: boolean;
  supportedReasoning: CanonicalReasoning[];
  defaultReasoning?: CanonicalReasoning;
  routeLabel: string;
  contextClass: string;
  speedClass: string;
  entitlement: string;
  quotaInfo: string;
  statusBadge: 'Connected' | 'Rate Limited' | 'Reauth Required' | 'Disabled' | 'Error' | 'Expiring' | 'Unknown';
  suitableRoles: string[];
  isLocal?: boolean;
  category: 'recommended' | 'team' | 'connected' | 'other' | 'local' | 'unavailable';
  warning?: string;
  source: ModelDescriptor['source'];
}

export interface AuthFlowResult {
  authId: string;
  method: string;
  url?: string;
  userCode?: string;
  instructions?: string;
  status: 'pending' | 'completed' | 'failed';
}

interface AccountState {
  accounts: AccountProfile[];
  runtimes: RuntimeStatus[];
  discoveredModels: DiscoveredModel[];
  loading: boolean;
  serviceOnline: boolean;
  error: string | null;
  setServiceOnline: (online: boolean, error?: string | null) => void;
  fetchAccounts: () => Promise<void>;
  discoverModels: () => void;
  discoverLocalClis: () => Promise<void>;
  addProfile: (
    provider: string,
    runtimeType: RuntimeType,
    profileName: string,
    configDir?: string,
    authMethod?: string,
    allowedRoles?: string[],
    schedulerAuto?: boolean,
    profileMode?: AccountProfile['profileMode'],
  ) => Promise<AccountProfile>;
  deleteProfile: (profileId: string) => Promise<void>;
  authenticateProfile: (profileId: string) => Promise<void>;
  beginAuthentication: (profileId: string, method: string, options?: Record<string, unknown>) => Promise<AuthFlowResult>;
  pollAuthentication: (profileId: string, authId: string) => Promise<{ status: AccountProfile['authStatus']; message?: string }>;
  logoutProfile: (profileId: string) => Promise<void>;
  toggleSchedulerAuto: (profileId: string) => Promise<void>;
  updateAllowedRoles: (profileId: string, roles: string[]) => Promise<void>;
  reauthenticateProfile: (profileId: string) => Promise<{ loginUrl?: string; deviceCode?: string }>;
  refreshModels: (profileId?: string) => Promise<void>;
}

function mapModels(models: ModelDescriptor[], accounts: AccountProfile[]): DiscoveredModel[] {
  return models.map((model) => {
    const account = accounts.find((profile) => profile.id === model.accountProfileId);
    const connected = account?.authStatus === 'connected';
    const available = connected && (model.availability === 'available' || model.availability === 'unknown');
    const roles = model.supportedRoles.map((role) => role[0].toUpperCase() + role.slice(1));
    const category: DiscoveredModel['category'] = !available
      ? 'unavailable'
      : model.providerId === 'local'
        ? 'local'
        : model.isDefault
          ? 'recommended'
          : 'connected';
    const statusBadge: DiscoveredModel['statusBadge'] = account?.authStatus === 'connected' ? 'Connected'
      : account?.authStatus === 'rate_limited' ? 'Rate Limited'
        : account?.authStatus === 'reauth_required' ? 'Reauth Required'
          : account?.authStatus === 'disabled' ? 'Disabled'
            : account?.authStatus === 'expiring' ? 'Expiring'
              : account?.authStatus === 'error' ? 'Error' : 'Unknown';
    return {
      id: model.catalogId,
      catalogId: model.catalogId,
      runtimeModelId: model.runtimeModelId,
      name: model.displayName,
      description: model.description,
      provider: model.providerId,
      runtimeType: model.runtimeId,
      accountProfileId: model.accountProfileId,
      accountName: account?.profileName || 'Unknown profile',
      available,
      availability: model.availability,
      supportsReasoning: model.supportedReasoning.length > 0,
      supportedReasoning: model.supportedReasoning,
      defaultReasoning: model.defaultReasoning,
      routeLabel: model.routeLabel || model.runtimeId,
      contextClass: model.contextWindow ? `${Math.round(model.contextWindow / 1_000)}k context` : 'Runtime reported',
      speedClass: 'Runtime managed',
      entitlement: model.entitlement || (model.source === 'discovered' ? 'Live account catalog' : 'Verify at run time'),
      quotaInfo: account?.remainingQuota || 'Not exposed by runtime',
      statusBadge,
      suitableRoles: roles,
      isLocal: model.providerId === 'local',
      category,
      warning: model.warning,
      source: model.source,
    };
  });
}

function rejectionMessage(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status !== 'rejected') return undefined;
  return result.reason instanceof Error ? result.reason.message : String(result.reason || 'Unknown error');
}

export const useAccountStore = create<AccountState>()(persist((set, get) => ({
  accounts: [],
  runtimes: [],
  discoveredModels: [],
  loading: false,
  serviceOnline: false,
  error: null,

  setServiceOnline: (online, error = null) => set({ serviceOnline: online, error: error ?? (online ? null : get().error) }),

  fetchAccounts: async () => {
    set({ loading: true, error: null });
    try {
      // Gateway liveness and catalog freshness are different concerns. Once
      // health succeeds, an individual discovery endpoint may degrade without
      // claiming the entire local service is offline.
      await checkApiHealth();
      const [accountsResult, runtimesResult, modelsResult] = await Promise.allSettled([
        apiRequest<AccountProfile[]>('/accounts'),
        apiRequest<RuntimeStatus[]>('/runtimes'),
        apiRequest<ModelDescriptor[]>('/models'),
      ]);
      const current = get();
      const accounts = accountsResult.status === 'fulfilled' ? accountsResult.value : current.accounts;
      const runtimes = runtimesResult.status === 'fulfilled' ? runtimesResult.value : current.runtimes;
      const discoveredModels = modelsResult.status === 'fulfilled'
        ? mapModels(modelsResult.value, accounts)
        : current.discoveredModels;
      const endpointErrors = [accountsResult, runtimesResult, modelsResult]
        .map(rejectionMessage)
        .filter((value): value is string => Boolean(value));
      set({
        accounts,
        runtimes,
        discoveredModels,
        serviceOnline: true,
        loading: false,
        error: endpointErrors.length
          ? `Local service is online, but some runtime data could not be refreshed. Showing cached data. ${endpointErrors[0]}`
          : null,
      });
    } catch (error: any) {
      set({
        serviceOnline: false,
        loading: false,
        error: error?.message || 'AtrisAgent local service is unavailable. Cached profiles and model routes are shown below.',
      });
    }
  },

  discoverLocalClis: async () => {
    set({ loading: true, error: null });
    try {
      const runtimes = await apiRequest<RuntimeStatus[]>('/runtimes/discover', { method: 'POST' });
      set({ runtimes, serviceOnline: true, loading: false });
    } catch (error: any) {
      set({ error: error?.message || 'Runtime discovery failed.', loading: false });
      throw error;
    }
  },

  addProfile: async (provider, runtimeType, profileName, _configDir, authMethod, allowedRoles, schedulerAuto, profileMode) => {
    const profile = await apiRequest<AccountProfile>('/accounts', {
      method: 'POST',
      body: JSON.stringify({ provider, runtimeType, profileName, authMethod, allowedRoles, schedulerAuto, profileMode }),
    });
    set((state) => ({ accounts: [...state.accounts, profile] }));
    return profile;
  },

  deleteProfile: async (profileId) => {
    await apiRequest(`/accounts/${profileId}`, { method: 'DELETE' });
    set((state) => ({
      accounts: state.accounts.filter((account) => account.id !== profileId),
      discoveredModels: state.discoveredModels.filter((model) => model.accountProfileId !== profileId),
    }));
  },

  authenticateProfile: async (profileId) => {
    const updated = await apiRequest<AccountProfile>(`/accounts/${profileId}/verify`, { method: 'POST' });
    set((state) => ({ accounts: state.accounts.map((account) => account.id === profileId ? updated : account) }));
    if (updated.authStatus === 'connected') await get().refreshModels(profileId);
  },

  beginAuthentication: async (profileId, method, options = {}) => {
    const result = await apiRequest<AuthFlowResult>(`/accounts/${profileId}/auth/begin`, {
      method: 'POST',
      body: JSON.stringify({ method, ...options }),
    });
    await get().fetchAccounts();
    return result;
  },

  pollAuthentication: async (profileId, authId) => {
    const result = await apiRequest<{ status: AccountProfile['authStatus']; message?: string }>(`/accounts/${profileId}/auth/${authId}`);
    await get().fetchAccounts();
    return result;
  },

  logoutProfile: async (profileId) => {
    const updated = await apiRequest<AccountProfile>(`/accounts/${profileId}/logout`, { method: 'POST' });
    set((state) => ({
      accounts: state.accounts.map((account) => account.id === profileId ? updated : account),
      discoveredModels: state.discoveredModels.filter((model) => model.accountProfileId !== profileId),
    }));
  },

  toggleSchedulerAuto: async (profileId) => {
    const existing = get().accounts.find((account) => account.id === profileId);
    if (!existing) return;
    const updated = await apiRequest<AccountProfile>(`/accounts/${profileId}`, {
      method: 'PATCH', body: JSON.stringify({ schedulerAuto: !(existing.schedulerAuto ?? true) }),
    });
    set((state) => ({ accounts: state.accounts.map((account) => account.id === profileId ? updated : account) }));
  },

  updateAllowedRoles: async (profileId, roles) => {
    const updated = await apiRequest<AccountProfile>(`/accounts/${profileId}`, {
      method: 'PATCH', body: JSON.stringify({ allowedRoles: roles }),
    });
    set((state) => ({ accounts: state.accounts.map((account) => account.id === profileId ? updated : account) }));
  },

  reauthenticateProfile: async (profileId) => {
    const profile = get().accounts.find((account) => account.id === profileId);
    if (!profile) throw new Error('Profile not found.');
    const runtime = get().runtimes.find((item) => item.runtimeType === profile.runtimeType);
    const method = profile.authMethod || runtime?.authMethods[0]?.id;
    if (!method) throw new Error('The runtime did not expose an authentication method.');
    const result = await get().beginAuthentication(profileId, method);
    return { loginUrl: result.url, deviceCode: result.userCode };
  },

  refreshModels: async (profileId) => {
    try {
      if (profileId) {
        await apiRequest(`/accounts/${profileId}/models/refresh`, { method: 'POST' });
      } else {
        await apiRequest<ModelDescriptor[]>('/models?refresh=true');
      }
      const accounts = await apiRequest<AccountProfile[]>('/accounts');
      const models = await apiRequest<ModelDescriptor[]>('/models');
      set({ accounts, discoveredModels: mapModels(models, accounts), serviceOnline: true, error: null });
    } catch (error: any) {
      set({ error: error?.message || 'Model catalog refresh failed.' });
      throw error;
    }
  },

  discoverModels: () => {
    // Catalog mapping is performed after real API discovery; no hard-coded fallback is injected.
  },
}), {
  name: 'atris-agent-account-cache-v1',
  partialize: (state) => ({
    accounts: state.accounts,
    runtimes: state.runtimes,
    discoveredModels: state.discoveredModels,
  }),
}));
