import fs from 'fs';
import path from 'path';
import type { ModelDescriptor, AccountProfile, RuntimeType } from '@atris-agent-code/domain';
import type { BaseRuntimeAdapter } from './adapters/base-adapter';
import { getAtrisDataDir, redactSecrets } from './runtime-utils';

const MAX_DISCOVERY_DIAGNOSTIC_CHARS = 1_500;

function discoveryDiagnostic(error: unknown): string {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const parts = [
    typeof record.message === 'string' ? record.message : undefined,
    typeof record.stderr === 'string' ? record.stderr : undefined,
    typeof record.stdout === 'string' ? record.stdout : undefined,
    typeof error === 'string' ? error : undefined,
  ].filter(Boolean).join('\n').trim();
  return redactSecrets(parts || 'runtime discovery failed').slice(-MAX_DISCOVERY_DIAGNOSTIC_CHARS);
}

export class ModelCatalogService {
  private cacheFilePath: string;
  private cachedCatalog = new Map<string, ModelDescriptor>();
  private adapters = new Map<string, BaseRuntimeAdapter>();

  constructor(adapters?: Map<string, BaseRuntimeAdapter>, customStorageDir?: string) {
    if (adapters) this.adapters = adapters;
    const storageDir = customStorageDir || getAtrisDataDir();
    fs.mkdirSync(storageDir, { recursive: true });
    this.cacheFilePath = path.join(storageDir, 'model-catalog-cache.json');
    this.loadCachedCatalog();
  }

  registerAdapter(adapter: BaseRuntimeAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  private loadCachedCatalog(): void {
    try {
      if (!fs.existsSync(this.cacheFilePath)) return;
      const list = JSON.parse(fs.readFileSync(this.cacheFilePath, 'utf8')) as ModelDescriptor[];
      if (!Array.isArray(list)) return;
      this.cachedCatalog.clear();
      for (const model of list) {
        const documented = model.source === 'documented';
        this.cachedCatalog.set(model.catalogId, {
          ...model,
          // Documented aliases remain documented across restarts. Routes that
          // came from a prior live discovery become cached and unverified.
          source: documented ? 'documented' : 'cached',
          availability: documented
            ? model.availability
            : model.availability === 'deprecated' ? 'deprecated' : 'unknown',
          warning: documented
            ? model.warning
            : model.warning || 'Cached route. Refresh the connected account before starting a run.',
        });
      }
    } catch (error) {
      console.warn('[ModelCatalogService] Could not load model catalog cache:', error);
    }
  }

  private saveCachedCatalog(): void {
    try {
      fs.writeFileSync(this.cacheFilePath, JSON.stringify([...this.cachedCatalog.values()], null, 2), 'utf8');
    } catch (error) {
      console.warn('[ModelCatalogService] Could not save model catalog cache:', error);
    }
  }

  async discoverLiveModels(accountProfiles: AccountProfile[]): Promise<ModelDescriptor[]> {
    let successfulProfiles = 0;
    let catalogChanged = false;
    for (const profile of accountProfiles) {
      if (profile.authStatus !== 'connected') continue;
      const adapter = this.adapters.get(profile.runtimeType);
      if (!adapter) continue;
      adapter.configureProfile(profile);
      try {
        const models = await adapter.discoverModels(profile.id);
        successfulProfiles += 1;
        catalogChanged = catalogChanged || this.getModelsForProfile(profile.id).length > 0 || models.length > 0;
        this.removeProfile(profile.id, false);
        for (const model of models) {
          const descriptor: ModelDescriptor = {
            ...model,
            accountProfileId: profile.id,
            runtimeId: profile.runtimeType,
            catalogId: model.catalogId || `${profile.runtimeType}:${profile.id}:${model.runtimeModelId}`,
            routeLabel: model.routeLabel || `${adapter.name} · ${profile.profileName}`,
            discoveredAt: model.discoveredAt || new Date().toISOString(),
          };
          this.cachedCatalog.set(descriptor.catalogId, descriptor);
        }
      } catch (error) {
        // A failed refresh is not authoritative, but the previous in-memory
        // live descriptors must not continue to claim that they are live.
        catalogChanged = this.markProfileStale(profile.id) || catalogChanged;
        console.warn(`[ModelCatalogService] Discovery failed for ${profile.profileName}: ${discoveryDiagnostic(error)}`);
      }
    }

    // A successful discovery is authoritative even when the runtime returns an
    // empty list. Persist removals so stale models cannot reappear after restart.
    if (successfulProfiles > 0 || catalogChanged) this.saveCachedCatalog();
    return this.getCachedCatalog();
  }

  async discoverForProfile(profile: AccountProfile): Promise<ModelDescriptor[]> {
    const adapter = this.adapters.get(profile.runtimeType);
    if (!adapter) throw new Error(`Runtime adapter '${profile.runtimeType}' is not registered.`);
    if (profile.authStatus !== 'connected') return [];
    adapter.configureProfile(profile);
    let models: ModelDescriptor[];
    try {
      models = await adapter.discoverModels(profile.id);
    } catch (error) {
      this.markProfileStale(profile.id);
      this.saveCachedCatalog();
      throw error;
    }
    this.removeProfile(profile.id, false);
    const normalized: ModelDescriptor[] = [];
    for (const model of models) {
      const descriptor: ModelDescriptor = {
        ...model,
        accountProfileId: profile.id,
        runtimeId: profile.runtimeType,
        catalogId: model.catalogId || `${profile.runtimeType}:${profile.id}:${model.runtimeModelId}`,
        routeLabel: model.routeLabel || `${adapter.name} · ${profile.profileName}`,
        discoveredAt: model.discoveredAt || new Date().toISOString(),
      };
      normalized.push(descriptor);
      this.cachedCatalog.set(descriptor.catalogId, descriptor);
    }
    this.saveCachedCatalog();
    return normalized;
  }

  getCachedCatalog(): ModelDescriptor[] {
    return [...this.cachedCatalog.values()];
  }

  getModelsForProfile(profileId: string): ModelDescriptor[] {
    return this.getCachedCatalog().filter((model) => model.accountProfileId === profileId);
  }

  getModelsForRuntime(runtimeType: RuntimeType): ModelDescriptor[] {
    return this.getCachedCatalog().filter((model) => model.runtimeId === runtimeType);
  }

  async resolveModelDescriptor(catalogId: string): Promise<ModelDescriptor | undefined> {
    return this.cachedCatalog.get(catalogId)
      || this.getCachedCatalog().find((model) => model.runtimeModelId === catalogId);
  }

  removeProfile(profileId: string, persist = true): void {
    let changed = false;
    for (const [catalogId, model] of this.cachedCatalog) {
      if (model.accountProfileId === profileId) {
        this.cachedCatalog.delete(catalogId);
        changed = true;
      }
    }
    if (changed && persist) this.saveCachedCatalog();
  }

  private markProfileStale(profileId: string): boolean {
    let changed = false;
    const warning = 'Live model discovery failed. This route is retained as unverified until the connected runtime is refreshed.';
    for (const [catalogId, model] of this.cachedCatalog) {
      if (model.accountProfileId !== profileId) continue;
      const nextAvailability = model.availability === 'deprecated' ? 'deprecated' : 'unknown';
      const nextSource = model.source === 'discovered' ? 'cached' : model.source;
      if (model.source === nextSource && model.availability === nextAvailability && model.warning === warning) continue;
      this.cachedCatalog.set(catalogId, {
        ...model,
        source: nextSource,
        availability: nextAvailability,
        warning,
      });
      changed = true;
    }
    return changed;
  }
}
