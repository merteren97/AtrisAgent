import fs from 'fs';
import os from 'os';
import path from 'path';
import { ModelCatalogService } from './model-catalog-service';

function model(profileId: string, id = 'model-old'): any {
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
    source: 'discovered',
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
          return [model(profile.id, 'model-known-good')];
        },
      };
      const service = new ModelCatalogService(undefined, dir);
      service.registerAdapter(adapter);
      await service.discoverLiveModels([profile]);
      failDiscovery = true;
      const degraded = await service.discoverLiveModels([profile]);
      assert(degraded.some((item) => item.runtimeModelId === 'model-known-good'), 'failed refresh keeps the last known model route instead of deleting it');

      const reloaded = new ModelCatalogService(undefined, dir);
      const cached = reloaded.getModelsForProfile(profile.id)[0];
      assert(cached?.source === 'cached' && cached?.availability === 'unknown', 'failed refresh cache reload is explicitly marked non-live');
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

  console.log(`Model catalog cache tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
