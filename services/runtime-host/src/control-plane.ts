import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentRole } from '@atris-agent-code/domain';
import type { SpawnAgentOptions } from './adapters/base-adapter';

export const ATRIS_MCP_SERVER_NAME = 'atris';
export const ATRIS_MCP_ALLOWED_TOOLS = [
  'agent_get_context',
  'agent_list',
  'agent_spawn',
  'agent_send_message',
  'agent_read_messages',
  'agent_await',
  'agent_request_review',
  'agent_handoff',
  'agent_report_progress',
  'agent_attach_context',
  'workspace_get_rules',
] as const;

export interface RuntimeControlPlaneGrantContext {
  agentInstanceId: string;
  missionId: string;
  taskId: string;
  role: AgentRole | string;
}

export interface RuntimeControlPlaneBridgeConfig {
  endpoint: string;
  bridgeScriptPath: string;
  /** Optional local sidecar token; delivered only to the bridge child environment. */
  runtimeToken?: string;
  issueGrant: (context: RuntimeControlPlaneGrantContext) => { token: string; expiresAt: string };
  revokeAgent?: (agentInstanceId: string) => void;
}

export interface PreparedControlPlaneSession {
  endpoint: string;
  bridgeScriptPath: string;
  token: string;
  expiresAt: string;
  serverName: typeof ATRIS_MCP_SERVER_NAME;
  runtimeToken?: string;
}

let bridgeConfig: RuntimeControlPlaneBridgeConfig | undefined;

export function configureRuntimeControlPlaneBridge(config?: RuntimeControlPlaneBridgeConfig): void {
  bridgeConfig = config;
}

export function prepareControlPlaneSession(options: SpawnAgentOptions, agentInstanceId: string): PreparedControlPlaneSession | undefined {
  // Supervisor decision/synthesis turns deliberately run outside the mission task
  // control plane. This prevents a synthetic Orchestrator decision session from
  // receiving worker-spawn tools or a grant bound to a non-existent task.
  if (options.enableCoordinationMcp === false) return undefined;
  if (!bridgeConfig) return undefined;
  const grant = bridgeConfig.issueGrant({
    agentInstanceId,
    missionId: options.missionId,
    taskId: options.taskId,
    role: options.role || 'builder',
  });
  return {
    endpoint: bridgeConfig.endpoint,
    bridgeScriptPath: bridgeConfig.bridgeScriptPath,
    token: grant.token,
    expiresAt: grant.expiresAt,
    serverName: ATRIS_MCP_SERVER_NAME,
    runtimeToken: bridgeConfig.runtimeToken,
  };
}

export function revokeControlPlaneAgent(agentInstanceId: string): void {
  bridgeConfig?.revokeAgent?.(agentInstanceId);
}

export function controlPlaneEnv(session?: PreparedControlPlaneSession): NodeJS.ProcessEnv {
  if (!session) return {};
  const environment: NodeJS.ProcessEnv = {
    ATRIS_CONTROL_PLANE_URL: session.endpoint,
    ATRIS_CONTROL_PLANE_TOKEN: session.token,
  };
  if (session.runtimeToken) environment.ATRIS_RUNTIME_TOKEN = session.runtimeToken;
  return environment;
}

export function appendControlPlaneInstructions(
  prompt: string,
  session: PreparedControlPlaneSession | undefined,
  workspacePath: string,
): string {
  if (!session) return prompt;
  return [
    prompt,
    'AtrisAgent coordination control plane is available through the MCP server named `atris`.',
    'Use Atris MCP tools for delegation and agent-to-agent coordination instead of simulating sub-agents in prose or shell processes.',
    'Call agent_get_context before non-trivial delegation. Use agent_spawn only when a bounded specialist would materially help; avoid unnecessary fan-out.',
    'Use agent_send_message/agent_handoff for coordination and agent_await for short synchronization. Use agent_request_review when independent review is valuable.',
    'Atris binds your mission, task, role, and agent identity server-side. Never attempt to override or impersonate those fields.',
    `Your assigned task workspace is: ${workspacePath}`,
  ].join('\n\n');
}

/** Codex accepts MCP servers through normal `-c key=value` config overrides. */
export function codexControlPlaneArgs(session?: PreparedControlPlaneSession): string[] {
  if (!session) return [];
  return [
    '-c', `mcp_servers.${ATRIS_MCP_SERVER_NAME}.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.${ATRIS_MCP_SERVER_NAME}.args=${JSON.stringify([session.bridgeScriptPath])}`,
    '-c', `mcp_servers.${ATRIS_MCP_SERVER_NAME}.startup_timeout_sec=10`,
  ];
}

export function createClaudeMcpConfig(session?: PreparedControlPlaneSession): { path?: string; cleanup: () => void } {
  if (!session) return { cleanup: () => undefined };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-claude-mcp-'));
  const configPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      [ATRIS_MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [session.bridgeScriptPath],
      },
    },
  }, null, 2), 'utf8');
  return {
    path: configPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export function claudeAllowedMcpTools(): string[] {
  return ATRIS_MCP_ALLOWED_TOOLS.map((tool) => `mcp__${ATRIS_MCP_SERVER_NAME}__${tool}`);
}

export function opencodeControlPlaneConfig(session: PreparedControlPlaneSession | undefined, version?: string): string | undefined {
  if (!session) return undefined;
  const command = [process.execPath, session.bridgeScriptPath];
  const major = Number(String(version || '').match(/(\d+)/)?.[1] || 1);
  if (major >= 2) {
    return JSON.stringify({
      mcp: {
        servers: {
          [ATRIS_MCP_SERVER_NAME]: {
            type: 'local',
            command,
            disabled: false,
            codemode: false,
          },
        },
      },
    });
  }
  return JSON.stringify({
    mcp: {
      [ATRIS_MCP_SERVER_NAME]: {
        type: 'local',
        command,
        enabled: true,
      },
    },
  });
}

export function createAntigravityMcpOverlay(
  session: PreparedControlPlaneSession | undefined,
  agentInstanceId: string,
  workspacePath: string,
): { cwd: string; extraArgs: string[]; cleanup: () => void } | undefined {
  if (!session) return undefined;
  const root = path.join(os.tmpdir(), 'AtrisAgent', 'antigravity-control-plane', agentInstanceId);
  const agentsDir = path.join(root, '.agents');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      [ATRIS_MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [session.bridgeScriptPath],
      },
    },
  }, null, 2), 'utf8');
  return {
    cwd: root,
    extraArgs: ['--add-dir', workspacePath],
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
