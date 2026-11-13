import { decodePairing, RemoteClient } from '@atris-agent-code/remote';
import { hubToken } from './hub-auth';
export type AgentStatus = 'working' | 'waiting' | 'idle' | 'offline' | 'error' | 'unknown';
export interface Workspace { id: string; name: string; path?: string; agents: Agent[] }
export interface Agent { id: string; conversationId: string; name: string; model: string; modelId?: string; reasoning?: string; runtime: string; status: AgentStatus; summary?: string }
export interface Message { id: string; role: 'user' | 'assistant' | 'tool'; text: string; time?: string }
export interface Model { id: string; name: string; runtime: string; reasoning: string[]; available: boolean; selected?: boolean }
export interface Session { connected: boolean; pendingApproval?: boolean; desktopName?: string; accountName?: string; lastSeen?: string }
export interface Question { id: string; questions: Array<{ header: string; question: string; options: Array<{ label: string; description?: string }>; multiple?: boolean; custom?: boolean }> }
export interface AgentControls { questions: Question[]; autoApprove?: { available: boolean; enabled: boolean }; permissions?: { available: boolean; mode?: string; runtimeId?: string; threadId?: string; revision?: number; applying?: boolean; reason?: string }; preferredMode: string | null; memory: { nodes: Array<{ id: string; title: string; summary: string }>; unavailable?: boolean } }
export const relay = import.meta.env.VITE_ATRIS_RELAY_URL || 'wss://agent.atrishub.com/remote/v1/ws';
let paired = false;
const client = new RemoteClient(undefined, () => { paired = false; window.dispatchEvent(new Event('desktop-disconnected')); });
export async function connectDesktop(code: string): Promise<void> {
  if (!hubToken()) throw new Error('Sign in to AtrisHub first.');
  const pairing = decodePairing(code.trim(), relay);
  paired = false;
  try {
    await client.connect(pairing, hubToken()!);
    const status = await client.request<Session>('session');
    if (!status.connected && !status.pendingApproval) throw new Error('Desktop could not verify this pairing.');
    paired = true;
  } catch (cause) { client.close(); throw cause; }
}
export function disconnectDesktop(): void { paired = false; client.close(); }
export const api = {
  session: () => paired ? client.request<Session>('session') : Promise.resolve<Session>({ connected: false }),
  workspaces: () => client.request<Workspace[]>('workspaces'),
  messages: (id: string) => client.request<Message[]>('messages', { agentId: id }),
  models: (id: string) => client.request<Model[]>('models', { agentId: id }),
  controls: (id: string) => client.request<AgentControls>('controls', { agentId: id }),
  replyQuestion: (agentId: string, questionId: string, answers: string[][]) => client.request('replyQuestion', { agentId, questionId, answers }),
  autoApprove: (agentId: string, enabled: boolean, expectedEnabled: boolean) => client.request('setAutoApprove', { agentId, enabled, expectedEnabled }),
  permissions: (agentId: string, mode: string, current: AgentControls, fullAccessConfirmed: boolean) => client.request('setPermissions', { agentId, ...current.permissions, mode, expectedMode: current.preferredMode, fullAccessConfirmed }),
  send: (workspaceId: string, agent: Agent, text: string, id: string) => client.request<{ status: 'delivered' | 'unknown' | 'rejected' }>('send', { agentId: agent.id, id, workspaceId, conversationId: agent.conversationId, text }),
  setModel: (agent: Agent, modelId: string, reasoning?: string) => client.request<Agent>('setModel', { agentId: agent.id, expectedModelId: agent.modelId, modelId, reasoning }),
};
