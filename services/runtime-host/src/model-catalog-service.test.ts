import fs from 'fs';
import os from 'os';
import path from 'path';
import { ModelCatalogService } from './model-catalog-service';

function model(profileId: string, id = 'model-old', source: 'discovered' | 'documented' = 'discovered'): any {
  return {
    catalogId: `claude_code:${profileId}:${id}`,
    runtimeId: 'claude_code',
    accountProfileId: profileId,
    providerId: 'anthropic',
    runtimeModelId: id,
    displayName: id,
    supportedRoles: ['builder'],
    supportedReasoning: ['medium'],
    inputModalities: ['text'],
    availability: 'available',
    source,
  };
}

async function runTests() {
  let passed = 0;
  let failed = 0;
  const assert = (condition: boolean, message: string) => {
    if (condition) {
      passed += 1;
      console.log(`[PASS] ${message}`);
    } else {
      failed += 1;
      console.error(`[FAIL] ${message}`);
    }
  };

  const profile: any = {
    id: 'profile-refresh',
    runtimeType: 'claude_code',
    provider: 'anthropic',
    profileName: 'Refresh Profile',
    authStatus: 'connected',
  };

  // A successful empty refresh is authoritative. The old profile slice must be
  // removed both in memory and on disk so restart cannot resurrect stale models.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-model-empty-refresh-'));
    try {
      let mode: 'model' | 'empty' = 'model';
      const adapter: any = {
        id: 'claude_code',
        name: 'Fake Claude',
        configureProfile() {},
        async discoverModels() { return mode === 'model' ? [model(profile.id)] : []; },
      };
      const service = new ModelCatalogService(undefined, dir);
      service.registerAdapter(adapter);
      assert((await service.discoverLiveModels([profile])).length === 1, 'initial live discovery caches the profile model');

      mode = 'empty';
      const refreshed = await service.discoverLiveModels([profile]);
      assert(refreshed.filter((item) => item.accountProfileId === profile.id).length === 0, 'successful empty refresh removes stale models immediately');

      const reloaded = new ModelCatalogService(undefined, dir);
      assert(reloaded.getModelsForProfile(profile.id).length === 0, 'successful empty refresh persists removal across restart');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // A discovery transport/runtime failure is not authoritative. Keep the last
  // known cache slice, but it reloads as availability=unknown/cached.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-model-failed-refresh-'));
    try {
      let failDiscovery = false;
      const adapter: any = {
        id: 'claude_code',
        name: 'Fake Claude',
        configureProfile() {},
        async discoverModels() {
          if (failDiscovery) throw new Error('runtime temporarily unavailable');
          return [model(profile.id, 'model-known-good'), model(profile.id, 'documented-alias', 'documented')];
        },
      };
      const service = new ModelCatalogService(undefined, dir);
      service.registerAdapter(adapter);
      await service.discoverLiveModels([profile]);
      failDiscovery = true;
      const degraded = await service.discoverLiveModels([profile]);
      assert(degraded.some((item) => item.runtimeModelId === 'model-known-good'), 'failed refresh keeps the last known model route instead of deleting it');
      const stale = degraded.find((item) => item.runtimeModelId === 'model-known-good');
      const documented = degraded.find((item) => item.runtimeModelId === 'documented-alias');
      assert(stale?.source === 'cached' && stale.availability === 'unknown', 'failed refresh marks the in-memory live route as cached and unverified');
      assert(documented?.source === 'documented' && documented.availability === 'unknown', 'failed refresh preserves documented model provenance while removing live availability');

      const reloaded = new ModelCatalogService(undefined, dir);
      const cached = reloaded.getModelsForProfile(profile.id)[0];
      assert(cached?.source === 'cached' && cached?.availability === 'unknown', 'failed refresh cache reload is explicitly marked non-live');
      assert(reloaded.getModelsForProfile(profile.id).some((item) => item.runtimeModelId === 'documented-alias' && item.source === 'documented'), 'documented provenance survives a cache reload');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Explicit logout/delete calls use removeProfile directly. That removal must
  // also persist or a stale route comes back the next time AtrisAgent starts.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-model-remove-profile-'));
    try {
      const adapter: any = {
        id: 'claude_code',
        name: 'Fake Claude',
        configureProfile() {},
        async discoverModels() { return [model(profile.id, 'model-to-remove')]; },
      };
      const service = new ModelCatalogService(undefined, dir);
      service.registerAdapter(adapter);
      await service.discoverLiveModels([profile]);
      service.removeProfile(profile.id);
      assert(service.getModelsForProfile(profile.id).length === 0, 'removeProfile clears the in-memory catalog slice');
      assert(new ModelCatalogService(undefined, dir).getModelsForProfile(profile.id).length === 0, 'removeProfile persists logout/delete cache removal');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Tier/strength tagging and bounded rate-limit cooldown recovery.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-model-tier-cooldown-'));
    try {
      const codexProfile = { ...profile, id: 'codex-prof', runtimeType: 'codex' as const, provider: 'openai' as const, profileName: 'Codex' };
      const adapter: any = {
        id: 'codex',
        name: 'Fake Codex',
        configureProfile() {},
        async discoverModels() {
          return [
            { ...model(codexProfile.id, 'gpt-5-mini'), runtimeId: 'codex', displayName: 'GPT-5 Mini', supportedReasoning: ['low', 'medium'] },
            { ...model(codexProfile.id, 'o3-pro'), runtimeId: 'codex', displayName: 'o3 Pro', supportedReasoning: ['high', 'xhigh'], contextWindow: 200_000 },
          ];
        },
      };
      const service = new ModelCatalogService(undefined, dir);
      service.registerAdapter(adapter);
      const discovered = await service.discoverForProfile(codexProfile);
      const mini = discovered.find((m) => m.runtimeModelId === 'gpt-5-mini')!;
      const pro = discovered.find((m) => m.runtimeModelId === 'o3-pro')!;
      assert(Boolean(mini.tier === 'fast' && mini.strengths?.includes('fast_iteration')), 'Mini model is tagged with fast tier and fast_iteration strength');
      assert(Boolean(pro.tier === 'deep' && pro.strengths?.includes('deep_reasoning') && pro.strengths?.includes('long_context')), 'Pro/xhigh model is tagged with deep tier and deep_reasoning/long_context strengths');

      const now = 1_000_000;
      service.markRateLimited(mini.catalogId, 30_000, 'HTTP 429', now);
      assert(service.isRateLimited(mini.catalogId, now + 10_000), 'Model remains rate_limited during cooldown window');
      assert(!service.isRateLimited(mini.catalogId, now + 31_000), 'Model automatically recovers once cooldown expires');
      const recovered = service.getCachedCatalog(now + 31_000).find((m) => m.catalogId === mini.catalogId);
      assert(recovered?.availability === 'available', 'Recovered model availability is restored to available');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`Model catalog cache tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
