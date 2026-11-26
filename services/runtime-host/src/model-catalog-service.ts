import fs from 'fs';
import path from 'path';
import type {
  ModelDescriptor,
  AccountProfile,
  RuntimeType,
  ModelRoutingTier,
  ModelStrengthTag,
} from '@atris-agent-code/domain';
import type { BaseRuntimeAdapter } from './adapters/base-adapter';
import { getAtrisDataDir, redactSecrets } from './runtime-utils';

export function inferModelTierAndStrengths(
  model: Pick<ModelDescriptor, 'runtimeId' | 'runtimeModelId' | 'displayName' | 'supportedReasoning' | 'inputModalities' | 'contextWindow' | 'tier' | 'strengths'>,
): { tier: ModelRoutingTier; strengths: ModelStrengthTag[] } {
  const idAndName = `${model.runtimeModelId} ${model.displayName}`.toLowerCase();
  const reasoning = model.supportedReasoning || [];
  const modalities = model.inputModalities || [];

  let tier: ModelRoutingTier = model.tier || 'balanced';
  if (!model.tier) {
    if (/(?:^|[-_/\s.])(mini|flash|haiku|nano|lite|fast|20b|4o-mini)(?:$|[-_/\s.])/i.test(idAndName)) {
      tier = 'fast';
    } else if (
      /(?:^|[-_/\s.])(opus|o1|o3|o4|pro|thinking|deep|reason|codex-max)(?:$|[-_/\s.])/i.test(idAndName)
      || reasoning.includes('xhigh')
      || reasoning.includes('max')
    ) {
      tier = 'deep';
    } else {
      tier = 'balanced';
    }
  }

  let strengths: ModelStrengthTag[];
  if (model.strengths && model.strengths.length > 0) {
    strengths = [...new Set(model.strengths)];
  } else {
    const inferred = new Set<ModelStrengthTag>();
    if (
      ['codex', 'claude_code', 'opencode'].includes(model.runtimeId)
      || /codex|sonnet|opus|coder|qwen|deepseek|gpt-5|claude/i.test(idAndName)
    ) {
      inferred.add('code_edit');
    }
    if (['codex', 'claude_code', 'opencode'].includes(model.runtimeId)) {
      inferred.add('shell_test');
    }
    if (
      tier === 'deep'
      || reasoning.some((level) => level === 'high' || level === 'xhigh' || level === 'max')
      || /thinking|reason|opus|o1|o3|o4|pro\b/i.test(idAndName)
    ) {
      inferred.add('deep_reasoning');
    }
    if ((model.contextWindow && model.contextWindow >= 128_000) || /gemini|claude|sonnet|opus|gpt-4\.1|gpt-5/i.test(idAndName)) {
      inferred.add('long_context');
    }
    if (modalities.includes('image') || /gemini|gpt-4o|gpt-5|claude|sonnet|opus/i.test(idAndName)) {
      inferred.add('multimodal');
    }
    if (tier === 'fast' || /flash|mini|haiku|nano|lite|fast/i.test(idAndName)) {
      inferred.add('fast_iteration');
    }
    strengths = [...inferred];
  }

  return { tier, strengths };
}

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
  private rateLimitedUntil = new Map<string, { expiresAt: number; reason?: string; previousAvailability: ModelDescriptor['availability'] }>();

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
        const { tier, strengths } = inferModelTierAndStrengths(model);
        this.cachedCatalog.set(model.catalogId, {
          ...model,
          tier,
          strengths,
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
    const temporaryPath = `${this.cacheFilePath}.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify([...this.cachedCatalog.values()], null, 2), 'utf8');
      fs.renameSync(temporaryPath, this.cacheFilePath);
    } catch (error) {
      try { fs.rmSync(temporaryPath, { force: true }); } catch { /* ignore cleanup failure */ }
      console.warn('[ModelCatalogService] Could not save model catalog cache:', error);
    }
  }

  async discoverLiveModels(accountProfiles: AccountProfile[]): Promise<ModelDescriptor[]> {
    const eligible = accountProfiles.flatMap((profile) => {
      if (profile.authStatus !== 'connected') return [];
      const adapter = this.adapters.get(profile.runtimeType);
      if (!adapter) return [];
      adapter.configureProfile(profile);
      return [{ profile, adapter }];
    });

    const settled = await Promise.allSettled(
      eligible.map(async ({ profile, adapter }) => ({
        profile,
        adapter,
        models: await adapter.discoverModels(profile.id),
      })),
    );

    let successfulProfiles = 0;
    let catalogChanged = false;
    settled.forEach((outcome, index) => {
      const { profile, adapter } = eligible[index];
      if (outcome.status === 'fulfilled') {
        const { models } = outcome.value;
        successfulProfiles += 1;
        catalogChanged = catalogChanged || this.getModelsForProfile(profile.id).length > 0 || models.length > 0;
        this.removeProfile(profile.id, false);
        for (const model of models) {
          const baseDescriptor: ModelDescriptor = {
            ...model,
            accountProfileId: profile.id,
            runtimeId: profile.runtimeType,
            catalogId: model.catalogId || `${profile.runtimeType}:${profile.id}:${model.runtimeModelId}`,
            routeLabel: model.routeLabel || `${adapter.name} · ${profile.profileName}`,
            discoveredAt: model.discoveredAt || new Date().toISOString(),
          };
          const { tier, strengths } = inferModelTierAndStrengths(baseDescriptor);
          const descriptor = this.applyRateLimitState({ ...baseDescriptor, tier, strengths });
          this.cachedCatalog.set(descriptor.catalogId, descriptor);
        }
      } else {
        // A failed refresh is not authoritative, but the previous in-memory
        // live descriptors must not continue to claim that they are live.
        catalogChanged = this.markProfileStale(profile.id) || catalogChanged;
        console.warn(`[ModelCatalogService] Discovery failed for ${profile.profileName}: ${discoveryDiagnostic(outcome.reason)}`);
      }
    });

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
      const baseDescriptor: ModelDescriptor = {
        ...model,
        accountProfileId: profile.id,
        runtimeId: profile.runtimeType,
        catalogId: model.catalogId || `${profile.runtimeType}:${profile.id}:${model.runtimeModelId}`,
        routeLabel: model.routeLabel || `${adapter.name} · ${profile.profileName}`,
        discoveredAt: model.discoveredAt || new Date().toISOString(),
      };
      const { tier, strengths } = inferModelTierAndStrengths(baseDescriptor);
      const descriptor = this.applyRateLimitState({ ...baseDescriptor, tier, strengths });
      normalized.push(descriptor);
      this.cachedCatalog.set(descriptor.catalogId, descriptor);
    }
    this.saveCachedCatalog();
    return normalized;
  }

  markRateLimited(catalogId: string, cooldownMs = 90_000, reason?: string, now = Date.now()): void {
    const boundedCooldown = Math.max(1_000, Math.min(cooldownMs, 10 * 60_000));
    const existing = this.cachedCatalog.get(catalogId);
    const prev = this.rateLimitedUntil.get(catalogId);
    const previousAvailability = existing && existing.availability !== 'rate_limited'
      ? existing.availability
      : prev?.previousAvailability || 'available';
    this.rateLimitedUntil.set(catalogId, {
      expiresAt: now + boundedCooldown,
      reason,
      previousAvailability,
    });
    if (existing) {
      this.cachedCatalog.set(catalogId, {
        ...existing,
        availability: 'rate_limited',
        warning: reason || existing.warning || 'Temporarily rate-limited.',
      });
    }
  }

  isRateLimited(catalogId: string, now = Date.now()): boolean {
    const entry = this.rateLimitedUntil.get(catalogId);
    if (!entry) return false;
    if (now >= entry.expiresAt) {
      this.clearExpiredCooldown(catalogId, entry);
      return false;
    }
    return true;
  }

  getActiveRateLimitedCatalogIds(now = Date.now()): Set<string> {
    const active = new Set<string>();
    for (const [catalogId, entry] of this.rateLimitedUntil.entries()) {
      if (now >= entry.expiresAt) {
        this.clearExpiredCooldown(catalogId, entry);
      } else {
        active.add(catalogId);
      }
    }
    return active;
  }

  private clearExpiredCooldown(
    catalogId: string,
    entry: { expiresAt: number; reason?: string; previousAvailability: ModelDescriptor['availability'] },
  ): void {
    this.rateLimitedUntil.delete(catalogId);
    const existing = this.cachedCatalog.get(catalogId);
    if (existing && existing.availability === 'rate_limited') {
      this.cachedCatalog.set(catalogId, {
        ...existing,
        availability: entry.previousAvailability,
        warning: existing.warning === entry.reason ? undefined : existing.warning,
      });
    }
  }

  private applyRateLimitState(descriptor: ModelDescriptor, now = Date.now()): ModelDescriptor {
    const entry = this.rateLimitedUntil.get(descriptor.catalogId);
    if (!entry) return descriptor;
    if (now >= entry.expiresAt) {
      this.rateLimitedUntil.delete(descriptor.catalogId);
      return descriptor;
    }
    return {
      ...descriptor,
      availability: 'rate_limited',
      warning: entry.reason || descriptor.warning || 'Temporarily rate-limited.',
    };
  }

  getCachedCatalog(now = Date.now()): ModelDescriptor[] {
    this.getActiveRateLimitedCatalogIds(now);
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
