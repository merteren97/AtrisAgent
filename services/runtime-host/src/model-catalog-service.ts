import fs from 'fs';
import path from 'path';
import type { ModelDescriptor, AccountProfile, RuntimeType } from '@atris-agent-code/domain';
import type { BaseRuntimeAdapter } from './adapters/base-adapter';
import { getAtrisDataDir } from './runtime-utils';

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
        this.cachedCatalog.set(model.catalogId, {
          ...model,
          source: 'cached',
          availability: model.availability === 'deprecated' ? 'deprecated' : 'unknown',
          warning: model.warning || 'Cached route. Refresh the connected account before starting a run.',
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
    for (const profile of accountProfiles) {
      if (profile.authStatus !== 'connected') continue;
      const adapter = this.adapters.get(profile.runtimeType);
      if (!adapter) continue;
      adapter.configureProfile(profile);
      try {
        const models = await adapter.discoverModels(profile.id);
        successfulProfiles += 1;
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
        // Keep the last known cache slice for this profile when live discovery
        // itself fails. Cached descriptors already load as availability=unknown,
        // so the UI can keep a degraded route visible without presenting it as live.
        console.warn(`[ModelCatalogService] Discovery failed for ${profile.profileName}:`, error);
      }
    }

    // A successful discovery is authoritative even when the runtime returns an
    // empty list. Persist removals so stale models cannot reappear after restart.
    if (successfulProfiles > 0) this.saveCachedCatalog();
    return this.getCachedCatalog();
  }

  async discoverForProfile(profile: AccountProfile): Promise<ModelDescriptor[]> {
    const adapter = this.adapters.get(profile.runtimeType);
    if (!adapter) throw new Error(`Runtime adapter '${profile.runtimeType}' is not registered.`);
    if (profile.authStatus !== 'connected') return [];
    adapter.configureProfile(profile);
    const models = await adapter.discoverModels(profile.id);
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
}
