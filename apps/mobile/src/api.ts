import { decodePairing, RemoteClient } from '@atris-agent-code/remote';
import { hubToken } from './hub-auth';
export type AgentStatus = 'working' | 'waiting' | 'idle' | 'offline' | 'error' | 'unknown';
export interface Workspace { id: string; name: string; path?: string; agents: Agent[]; plans?: WorkspaceItem[] | null; missions?: WorkspaceItem[] | null }
export interface WorkspaceItem { id: string; title: string; status: string }
export interface PlanDetail { content: string; truncated: boolean }
export interface MissionDetail { description: string; tasks: Array<{ id: string; title: string; status: string; description: string }> }
export interface Agent { id: string; conversationId: string; name: string; model: string; modelId?: string; reasoning?: string; runtime: string; status: AgentStatus; summary?: string }
export interface Message { id: string; role: 'user' | 'assistant' | 'tool'; text: string; time?: string }
export interface Model { id: string; name: string; runtime: string; reasoning: string[]; available: boolean; selected?: boolean }
export interface Session { connected: boolean; pendingApproval?: boolean; desktopName?: string; accountName?: string; lastSeen?: string }
export interface Question { id: string; questions: Array<{ header: string; question: string; options: Array<{ label: string; description?: string }>; multiple?: boolean; custom?: boolean }> }
export interface AgentControls { questions: Question[]; autoApprove?: { available: boolean; enabled: boolean }; permissions?: { available: boolean; mode?: string; runtimeId?: string; threadId?: string; revision?: number; applying?: boolean; reason?: string }; preferredMode: string | null; memory: { nodes: Array<{ id: string; title: string; summary: string }>; unavailable?: boolean } }
export const relay = import.meta.env.VITE_ATRIS_RELAY_URL || 'wss://agent.atrishub.com/remote/v1/ws';
const DEVICE_ID_KEY = 'atris.mobile.device-id.v1';
const PAIRING_STORAGE_KEY = 'atris.mobile.desktop-pairing.v1';
let paired = false;
let reconnecting: Promise<Session> | null = null;
const client = new RemoteClient(undefined, () => { paired = false; window.dispatchEvent(new Event('desktop-disconnected')); });
function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}
function readSavedPairing(): string | null {
  try { return localStorage.getItem(PAIRING_STORAGE_KEY); } catch { return null; }
}
function writeSavedPairing(code: string): void {
  try { localStorage.setItem(PAIRING_STORAGE_KEY, code); } catch { /* ignore */ }
}
function clearSavedPairing(): void {
  try { localStorage.removeItem(PAIRING_STORAGE_KEY); } catch { /* ignore */ }
}
export function hasSavedPairing(): boolean { return Boolean(readSavedPairing()); }
async function establishConnection(code: string, allowExpired: boolean): Promise<Session> {
  const token = hubToken();
  if (!token) throw new Error('Sign in to AtrisHub first.');
  const trimmed = code.trim();
  const pairing = decodePairing(trimmed, relay, allowExpired ? { allowExpired: true } : undefined);
  paired = false;
  try {
    await client.connect(pairing, token, getDeviceId());
    const status = await client.request<Session>('session');
    if (!status.connected && !status.pendingApproval) throw new Error('Desktop could not verify this pairing.');
    paired = true;
    writeSavedPairing(trimmed);
    return status;
  } catch (cause) { client.close(); throw cause; }
}
export async function connectDesktop(code: string): Promise<void> {
  await establishConnection(code, false);
}
export function disconnectDesktop(): void { paired = false; clearSavedPairing(); client.close(); }
async function ensureSession(): Promise<Session> {
  if (paired) return client.request<Session>('session');
  const saved = readSavedPairing();
  if (!saved || !hubToken()) return { connected: false };
  if (!reconnecting) {
    reconnecting = establishConnection(saved, true).finally(() => { reconnecting = null; });
  }
  return reconnecting;
}
export const api = {
  session: () => ensureSession(),
  workspaces: () => client.request<Workspace[]>('workspaces'),
  planDetail: (workspaceId: string, planId: string) => client.request<PlanDetail>('planDetail', { workspaceId, planId }),
  missionDetail: (workspaceId: string, missionId: string) => client.request<MissionDetail>('missionDetail', { workspaceId, missionId }),
  messages: (id: string) => client.request<Message[]>('messages', { agentId: id }),
  models: (id: string) => client.request<Model[]>('models', { agentId: id }),
  controls: (id: string) => client.request<AgentControls>('controls', { agentId: id }),
  replyQuestion: (agentId: string, questionId: string, answers: string[][]) => client.request('replyQuestion', { agentId, questionId, answers }),
  autoApprove: (agentId: string, enabled: boolean, expectedEnabled: boolean) => client.request('setAutoApprove', { agentId, enabled, expectedEnabled }),
  permissions: (agentId: string, mode: string, current: AgentControls, fullAccessConfirmed: boolean) => client.request('setPermissions', { agentId, ...current.permissions, mode, expectedMode: current.preferredMode, fullAccessConfirmed }),
  send: (workspaceId: string, agent: Agent, text: string, id: string) => client.request<{ status: 'delivered' | 'unknown' | 'rejected' }>('send', { agentId: agent.id, id, workspaceId, conversationId: agent.conversationId, text }),
  setModel: (agent: Agent, modelId: string, reasoning?: string) => client.request<Agent>('setModel', { agentId: agent.id, expectedModelId: agent.modelId, modelId, reasoning }),
};
