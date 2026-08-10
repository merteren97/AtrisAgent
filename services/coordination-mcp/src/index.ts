import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CoordinationMCPServer } from './mcp-server';

export { CoordinationMCPServer };
export type { CoordinationMCPServerOptions } from './mcp-server';
export { CoordinationMCP } from './coordination';
export { ResourceLeaseManager } from './resource-lease-manager';

/** Absolute path passed to native CLI runtimes when Atris injects its stdio MCP bridge. */
export function resolveControlPlaneBridgeScriptPath(
  environment: NodeJS.ProcessEnv = process.env,
  moduleUrl?: string,
): string {
  const configured = environment.ATRIS_CONTROL_PLANE_BRIDGE_PATH?.trim();
  if (configured) return path.resolve(configured);

  // Source callers may pass their module URL explicitly. Keeping import.meta out
  // of this module is intentional: the packaged gateway is bundled as CommonJS,
  // where esbuild cannot preserve import.meta.url.
  if (moduleUrl) {
    const adjacent = fileURLToPath(new URL('./control-plane-bridge.mjs', moduleUrl));
    if (existsSync(adjacent)) return adjacent;
    const sourceFallback = fileURLToPath(new URL('../src/control-plane-bridge.mjs', moduleUrl));
    if (existsSync(sourceFallback)) return sourceFallback;
  }

  // npm workspaces execute scripts with the package directory as cwd, while
  // repository tooling may execute from the repository root. Cover both shapes
  // without embedding a build-machine absolute path into the packaged bundle.
  const candidates = [
    path.resolve(process.cwd(), 'src', 'control-plane-bridge.mjs'),
    path.resolve(process.cwd(), 'services', 'coordination-mcp', 'src', 'control-plane-bridge.mjs'),
    path.resolve(process.cwd(), '..', 'coordination-mcp', 'src', 'control-plane-bridge.mjs'),
  ];
  const sourceFallback = candidates.find((candidate) => existsSync(candidate));
  if (sourceFallback) return sourceFallback;

  throw new Error(
    'Could not resolve the AtrisAgent control-plane bridge. Packaged runtimes must set ATRIS_CONTROL_PLANE_BRIDGE_PATH.',
  );
}

export function getControlPlaneBridgeScriptPath(): string {
  return resolveControlPlaneBridgeScriptPath();
}

function isStandaloneCoordinationEntry(executablePath: string | undefined = process.argv[1]): boolean {
  if (!executablePath) return false;
  const absolute = path.resolve(executablePath);
  const fileName = path.basename(absolute).toLowerCase();
  const sourceDirectory = path.dirname(absolute);
  return (fileName === 'index.ts' || fileName === 'index.js' || fileName === 'index.mjs')
    && path.basename(sourceDirectory).toLowerCase() === 'src'
    && path.basename(path.dirname(sourceDirectory)).toLowerCase() === 'coordination-mcp';
}

// Standalone execution entrypoint. Avoid import.meta here because this module is
// also bundled into the packaged CommonJS gateway.
if (isStandaloneCoordinationEntry()) {
  const server = new CoordinationMCPServer();
  server.startStdio().catch((err) => {
    console.error('Failed to start Coordination MCP Server:', err);
    process.exit(1);
  });
}
