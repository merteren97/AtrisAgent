import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { CoordinationMCPServer } from './mcp-server';

export { CoordinationMCPServer };
export type { CoordinationMCPServerOptions } from './mcp-server';
export { CoordinationMCP } from './coordination';
export { ResourceLeaseManager } from './resource-lease-manager';

/** Absolute path passed to native CLI runtimes when Atris injects its stdio MCP bridge. */
export function resolveControlPlaneBridgeScriptPath(
  environment: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): string {
  const configured = environment.ATRIS_CONTROL_PLANE_BRIDGE_PATH?.trim();
  if (configured) return path.resolve(configured);

  const adjacent = fileURLToPath(new URL('./control-plane-bridge.mjs', moduleUrl));
  if (existsSync(adjacent)) return adjacent;
  const sourceFallback = fileURLToPath(new URL('../src/control-plane-bridge.mjs', moduleUrl));
  return sourceFallback;
}

export function getControlPlaneBridgeScriptPath(): string {
  return resolveControlPlaneBridgeScriptPath();
}

// Standalone execution entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new CoordinationMCPServer();
  server.startStdio().catch((err) => {
    console.error('Failed to start Coordination MCP Server:', err);
    process.exit(1);
  });
}
