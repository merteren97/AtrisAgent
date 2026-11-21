import type { WorktreeManager } from '@atris-agent-code/workspace-manager';

type FileList = Awaited<ReturnType<WorktreeManager['getReviewFileList']>>;
type PendingScan = {
  result: Promise<FileList>;
  started: boolean;
  invalidated: boolean;
  refresh: boolean;
};

const CACHE_TTL_MS = 10_000;
const CACHE_LIMIT = 24;
const MAX_ACTIVE_SCANS = 2;
const MAX_PENDING_WORKTREES = 32;

/** Shared by the staged task list and mission summary; never used for live changes. */
export class StagedChanges {
  private readonly cache = new Map<string, { files: FileList; at: number }>();
  private readonly pending = new Map<string, PendingScan>();
  private readonly waiters: Array<() => void> = [];
  private active = 0;

  constructor(private readonly scan: (path: string) => Promise<FileList>, private readonly now = () => performance.now()) {}

  invalidate(path: string): void {
    this.cache.delete(path);
    const scan = this.pending.get(path);
    if (scan?.started) scan.invalidated = true;
  }

  lastKnown(path: string, maxAge = CACHE_TTL_MS): FileList | undefined {
    const cached = this.cache.get(path);
    return cached && this.now() - cached.at < maxAge ? cached.files : undefined;
  }

  list(path: string, refresh = false): Promise<FileList> {
    const previous = this.pending.get(path);
    if (refresh && !previous?.refresh) this.invalidate(path);
    if (previous && !previous.invalidated) return previous.result;

    const cached = this.lastKnown(path);
    if (cached) return Promise.resolve(cached);
    if (!previous && this.pending.size >= MAX_PENDING_WORKTREES) {
      return Promise.reject(Object.assign(new Error('Too many staged Changes scans. Try again shortly.'), { status: 503 }));
    }

    const result = Promise.resolve().then(async () => {
      // A refresh after invalidation must start after the previous scan, not overlap it.
      if (previous) await previous.result.catch(() => {});
      return this.withScanSlot(async () => {
        entry.started = true;
        const files = await this.scan(path);
        if (!entry.invalidated) {
          this.cache.delete(path);
          this.cache.set(path, { files, at: this.now() });
          if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
        }
        return files;
      });
    }).finally(() => {
      if (this.pending.get(path) === entry) this.pending.delete(path);
    });
    const entry: PendingScan = { result, started: false, invalidated: false, refresh };
    this.pending.set(path, entry);
    return result;
  }

  private async withScanSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < MAX_ACTIVE_SCANS) this.active++;
    else await new Promise<void>(resolve => this.waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
