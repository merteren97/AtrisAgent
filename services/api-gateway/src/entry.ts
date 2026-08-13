import { CoordinationMCP, getControlPlaneBridgeScriptPath } from '@atris-agent-code/coordination-mcp';
import { configureRuntimeControlPlaneBridge } from '@atris-agent-code/runtime-host';
import { app, server, eventBus, workspaceManager, orchestrator, shutdownCoordinator } from './index';
import { ControlPlaneGrantRegistry } from './control-plane-grants';
import { installControlPlaneRoutes } from './control-plane-router';
import { installProjectMemoryRoutes } from './project-memory-routes';
import {
  emitRuntimeReady,
  gatewayOrigin,
  gatewayVersion,
  resolveGatewayPort,
  runtimeTokenFromEnvironment,
  startParentWatchdog,
} from './runtime-protocol';

const PORT = resolveGatewayPort();
const runtimeToken = runtimeTokenFromEnvironment();

const coordination = new CoordinationMCP({
  workspaceManager,
  orchestrator,
  eventBus,
  workspacePath: process.cwd(),
});
const grants = new ControlPlaneGrantRegistry();

installControlPlaneRoutes(app, {
  coordination,
  eventBus,
  workspaceManager,
  grants,
});

const projectMemory = orchestrator.getProjectMemoryService();
if (projectMemory) {
  installProjectMemoryRoutes(app, {
    memory: projectMemory,
    workspaceManager,
  });
}

function configureBridgeForListeningServer(): string | undefined {
  const address = server.address();
  if (!address || typeof address === 'string') return undefined;
  const origin = gatewayOrigin(address.port);
  configureRuntimeControlPlaneBridge({
    endpoint: origin,
    bridgeScriptPath: getControlPlaneBridgeScriptPath(),
    runtimeToken,
    issueGrant: (context) => grants.issue(context),
    revokeAgent: (agentInstanceId) => grants.revokeAgent(agentInstanceId),
  });
  return origin;
}

let controlPlaneCleared = false;
const clearControlPlane = () => {
  if (controlPlaneCleared) return;
  controlPlaneCleared = true;
  grants.clear();
  configureRuntimeControlPlaneBridge(undefined);
};
shutdownCoordinator.addCleanup(clearControlPlane);

const stopParentWatchdog = startParentWatchdog({
  onParentExit: () => { void shutdownCoordinator.shutdown('parent-exit'); },
});
const handleShutdownSignal = () => { void shutdownCoordinator.shutdown('process-signal'); };
if (process.env.NODE_ENV !== 'test') {
  process.once('SIGINT', handleShutdownSignal);
  process.once('SIGTERM', handleShutdownSignal);
}
server.on('close', () => {
  stopParentWatchdog();
  clearControlPlane();
  process.off('SIGINT', handleShutdownSignal);
  process.off('SIGTERM', handleShutdownSignal);
});

if (!server.listening) {
  server.listen(PORT, '127.0.0.1', () => {
    const origin = configureBridgeForListeningServer();
    const ready = emitRuntimeReady(server, gatewayVersion());
    const actualOrigin = ready?.origin || origin || `http://127.0.0.1:${PORT}`;
    console.log(`[API-Gateway] Server running on ${actualOrigin}`);
    console.log(`[API-Gateway] Native CLI control plane ready through session-scoped MCP grants`);
    console.log(`[API-Gateway] WebSocket stream ready at ${actualOrigin.replace(/^http:/, 'ws:')}/ws/events`);
    console.log(`[API-Gateway] SSE event stream ready at ${actualOrigin}/api/events/stream`);
  });
} else {
  configureBridgeForListeningServer();
  emitRuntimeReady(server, gatewayVersion());
}

export { coordination, grants };
