import fs from 'fs';
import path from 'path';
import type { AccountProfile, AccountProfileStatus, RuntimeType } from '@atris-agent-code/domain';
import type { BaseRuntimeAdapter } from './adapters/base-adapter';
import { getAtrisDataDir } from './runtime-utils';

export class AccountProfileManager {
  private storageDir: string;
  private cacheFilePath: string;
  private profilesMap: Map<string, AccountProfile> = new Map();

  constructor(customStorageDir?: string) {
    this.storageDir = customStorageDir || path.join(getAtrisDataDir(), 'profiles');
    this.cacheFilePath = path.join(this.storageDir, 'account-profiles.json');
    this.ensureStorage();
    this.loadFromDisk();
  }

  private ensureStorage(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    }
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.cacheFilePath)) return;
    try {
      const raw = fs.readFileSync(this.cacheFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as AccountProfile[] | { version?: number; profiles?: AccountProfile[] };
      const list = Array.isArray(parsed) ? parsed : parsed.profiles;
      if (!Array.isArray(list)) throw new Error('Account profile registry does not contain a profiles array.');
      this.profilesMap.clear();
      for (const profile of list) {
        if (!profile || typeof profile.id !== 'string' || typeof profile.runtimeType !== 'string') continue;
        this.profilesMap.set(profile.id, profile);
      }
    } catch (err) {
      const corruptPath = `${this.cacheFilePath}.corrupt-${Date.now()}`;
      try { fs.renameSync(this.cacheFilePath, corruptPath); } catch { /* preserve original error */ }
      console.warn(`[AccountProfileManager] The account profile registry was invalid and was moved to ${corruptPath}:`, err);
      this.profilesMap.clear();
    }
  }

  private saveToDisk(): void {
    this.ensureStorage();
    const payload = {
      version: 1,
      profiles: Array.from(this.profilesMap.values()),
    };
    const temporaryPath = `${this.cacheFilePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(temporaryPath, this.cacheFilePath);
      try { fs.chmodSync(this.cacheFilePath, 0o600); } catch { /* Windows may ignore POSIX modes */ }
    } catch (err) {
      try { fs.rmSync(temporaryPath, { force: true }); } catch { /* ignore cleanup failure */ }
      throw new Error(`Failed to persist account profile metadata: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getProfileDir(runtimeType: RuntimeType, profileId: string): string {
    const dir = path.join(this.storageDir, runtimeType, profileId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
  }

  async getProfiles(): Promise<AccountProfile[]> {
    return Array.from(this.profilesMap.values());
  }

  async getProfileById(profileId: string): Promise<AccountProfile | undefined> {
    return this.profilesMap.get(profileId);
  }

  async createProfile(data: Omit<AccountProfile, 'id' | 'createdAt' | 'updatedAt'>): Promise<AccountProfile> {
    const id = globalThis.crypto.randomUUID();
    const now = new Date().toISOString();
    const profile: AccountProfile = {
      ...data,
      id,
      configDir: data.configDir || this.getProfileDir(data.runtimeType, id),
      createdAt: now,
      updatedAt: now,
    };
    this.profilesMap.set(id, profile);
    try {
      this.saveToDisk();
    } catch (error) {
      this.profilesMap.delete(id);
      throw error;
    }
    return profile;
  }

  async updateProfile(profileId: string, updates: Partial<AccountProfile>): Promise<AccountProfile> {
    const existing = this.profilesMap.get(profileId);
    if (!existing) {
      throw new Error(`Account profile ${profileId} not found`);
    }
    const updated: AccountProfile = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.profilesMap.set(profileId, updated);
    try {
      this.saveToDisk();
    } catch (error) {
      this.profilesMap.set(profileId, existing);
      throw error;
    }
    return updated;
  }

  async deleteProfile(profileId: string): Promise<boolean> {
    const existing = this.profilesMap.get(profileId);
    if (!existing) return false;

    this.profilesMap.delete(profileId);
    try {
      this.saveToDisk();
    } catch (error) {
      this.profilesMap.set(profileId, existing);
      throw error;
    }

    try {
      const dir = path.join(this.storageDir, existing.runtimeType, profileId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // ignore dir cleanup error
    }

    return true;
  }

  async refreshProfileAuthStatus(profileId: string, adapter: BaseRuntimeAdapter): Promise<AccountProfileStatus> {
    const profile = this.profilesMap.get(profileId);
    if (!profile) throw new Error(`Profile ${profileId} not found`);

    const status = await adapter.verifyAuthentication(profileId);
    await this.updateProfile(profileId, { authStatus: status });
    return status;
  }
}
