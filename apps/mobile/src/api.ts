export type AgentStatus = 'working' | 'waiting' | 'idle' | 'offline' | 'error';
export interface Workspace { id: string; name: string; path?: string; agents: Agent[] }
export interface Agent { id: string; conversationId: string; name: string; model: string; reasoning?: string; runtime: string; status: AgentStatus; summary?: string }
export interface Message { id: string; role: 'user' | 'assistant' | 'tool'; text: string; time?: string }
export interface Model { id: string; name: string; runtime: string; reasoning: string[]; available: boolean }
export interface Session { connected: boolean; desktopName?: string; accountName?: string; lastSeen?: string }

// This API contract deliberately requires a separately authenticated mobile
// bridge. The desktop loopback gateway must never be exposed directly.
const base = (import.meta.env.VITE_ATRIS_MOBILE_API_URL || '/api/mobile').replace(/\/$/, '');
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers }, credentials: 'include' });
  if (!response.ok) throw new Error(response.status === 401 ? 'Your connection has expired.' : 'Could not reach the desktop.');
  return response.json() as Promise<T>;
}
export const api = {
  session: () => request<Session>('/session'),
  workspaces: () => request<Workspace[]>('/workspaces'),
  messages: (id: string) => request<Message[]>(`/agents/${encodeURIComponent(id)}/messages`),
  models: (id: string) => request<Model[]>(`/agents/${encodeURIComponent(id)}/models`),
  send: (workspaceId: string, agent: Agent, text: string, id: string) => request<{ status: 'delivered' | 'unknown' }>(`/agents/${encodeURIComponent(agent.id)}/messages`, { method: 'POST', body: JSON.stringify({ id, workspaceId, conversationId: agent.conversationId, text }) }),
  setModel: (agent: Agent, modelId: string, reasoning?: string) => request<Agent>(`/agents/${encodeURIComponent(agent.id)}/model`, { method: 'PATCH', body: JSON.stringify({ modelId, reasoning }) }),
};
