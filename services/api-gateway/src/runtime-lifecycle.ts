import type { Express, Request, Response } from 'express';
import { createRuntimeTokenMiddleware } from './runtime-protocol';

type Awaitable = void | Promise<void>;

export interface RuntimeShutdownResources {
  stopRuntimeHost?: () => Awaitable;
  clearControlPlane?: () => Awaitable;
  closeServer?: () => Awaitable;
  closeDatabase?: () => Awaitable;
}

export interface RuntimeShutdownOptions {
  /** Maximum time allowed for graceful cleanup before the process is forced down. */
  timeoutMs?: number;
  /** Injectable for tests; production passes process.exit. */
  forceExit?: (code: number) => void;
  /** Called once after graceful cleanup succeeds. */
  onComplete?: (reason: string) => void;
}

export interface RuntimeShutdownCoordinator {
  shutdown(reason?: string): Promise<void>;
  addCleanup(cleanup: () => Awaitable): () => void;
  get shuttingDown(): boolean;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

function boundedTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(value as number), 250), 60_000);
}

/**
 * Build one idempotent shutdown path for signals, parent death and the local
 * packaged-runtime shutdown endpoint. Each cleanup is invoked at most once,
 * and a hung child cannot keep the sidecar alive indefinitely.
 */
export function createRuntimeShutdownCoordinator(
  resources: RuntimeShutdownResources = {},
  options: RuntimeShutdownOptions = {},
): RuntimeShutdownCoordinator {
  const cleanups: Array<() => Awaitable> = [];
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const forceExit = options.forceExit || ((code: number) => process.exit(code));
  let shutdownPromise: Promise<void> | undefined;
  let completed = false;

  for (const cleanup of [
    resources.stopRuntimeHost,
    resources.clearControlPlane,
    resources.closeServer,
    resources.closeDatabase,
  ]) {
    if (cleanup) cleanups.push(cleanup);
  }

  const run = async (reason: string): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        forceExit(1);
        finish();
      }, timeoutMs);

      (async () => {
        for (const cleanup of cleanups) {
          try {
            await cleanup();
          } catch {
            // A later cleanup (server/database close) must still run. The
            // process-level timeout is the final safety net for a hung one.
          }
        }
        finish();
      })();
    });
    if (!completed) {
      completed = true;
      options.onComplete?.(reason);
    }
  };

  return {
    shutdown(reason = 'requested'): Promise<void> {
      if (!shutdownPromise) shutdownPromise = run(reason);
      return shutdownPromise;
    },
    addCleanup(cleanup: () => Awaitable): () => void {
      if (completed) return () => undefined;
      cleanups.push(cleanup);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const index = cleanups.indexOf(cleanup);
        if (index >= 0) cleanups.splice(index, 1);
      };
    },
    get shuttingDown(): boolean {
      return Boolean(shutdownPromise);
    },
  };
}

/**
 * The route is registered only for protected packaged runtimes. The global
 * runtime-token middleware remains the first gate; this local middleware also
 * makes the helper safe to use with an isolated Express app in tests.
 */
export function installRuntimeShutdownRoute(
  app: Express,
  runtimeToken: string | undefined,
  coordinator: RuntimeShutdownCoordinator,
): boolean {
  if (!runtimeToken) return false;
  app.post('/api/internal/runtime/shutdown', createRuntimeTokenMiddleware(runtimeToken), (req: Request, res: Response) => {
    if (coordinator.shuttingDown) {
      res.status(202).json({ ok: true, shuttingDown: true });
      return;
    }
    res.status(202).json({ ok: true, shuttingDown: true });
    void coordinator.shutdown('http-shutdown');
  });
  return true;
}
