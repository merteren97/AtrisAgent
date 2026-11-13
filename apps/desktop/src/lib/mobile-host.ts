import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { createPairing, encodePairing, RemoteHost, type DeviceConnection } from '@atris-agent-code/remote';
import { apiRequest } from './api-client';
import { RemoteAgentCommands } from './remote-agent-commands';
import { createRemoteAgentHost } from './remote-agent-host';
import type { ManualAgent, ManualConversation, ManualMessage } from '@/stores/manual-store';
import { useManualStore } from '@/stores/manual-store';
import { useAccountStore } from '@/stores/account-store';
import { isTauriRuntime } from './secure-storage';

const defaultRelay = import.meta.env?.VITE_ATRIS_RELAY_URL || 'wss://agent.atrishub.com/remote/v1/ws';
interface MobileHostState { status: 'disabled' | 'connecting' | 'online' | 'error'; code: string; error: string; devices: DeviceConnection[]; expiresAt: number }
export const useMobileHost = create<MobileHostState>(() => ({ status: 'disabled', code: '', error: '', devices: [], expiresAt: 0 }));
let host: RemoteHost | undefined;
let generation = 0;

const commands = new RemoteAgentCommands(createRemoteAgentHost({
  conversations: workspaceId => apiRequest<ManualConversation[]>(`/manual/conversations?workspaceId=${encodeURIComponent(workspaceId)}`),
  terminalStatus: id => invoke('manual_terminal_snapshot', { id, after: 0, statusOnly: true }),
  writeMessage: (id, text) => invoke('manual_terminal_write', { id, data: text, paste: true }),
}));
function required(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 200) throw new Error('Invalid identifier'); return value; }
async function findAgent(id: string): Promise<{ agent: ManualAgent; workspaceId: string }> {
  const workspaces = await apiRequest<Array<{ id: string }>>('/workspaces');
  for (const workspace of workspaces) {
    const conversations = await apiRequest<ManualConversation[]>(`/manual/conversations?workspaceId=${encodeURIComponent(workspace.id)}`);
    for (const conversation of conversations) { const agent = conversation.agents.find(item => item.id === id); if (agent) return { agent, workspaceId: workspace.id }; }
  }
  throw new Error('Agent no longer exists.');
}
async function agentView(agent: ManualAgent) {
  const status = await invoke<{ status: string; inputReady?: boolean }>('manual_terminal_snapshot', { id: agent.id, after: 0, statusOnly: true });
  const activity = status.status === 'open' ? await apiRequest<{ state: string }>(`/manual/agents/${agent.id}/activity`) : { state: 'offline' };
  const model = useAccountStore.getState().discoveredModels.find(value => value.catalogId === agent.catalogId);
  return { id: agent.id, conversationId: agent.conversationId, name: agent.name, model: model?.name || agent.model, modelId: agent.catalogId, reasoning: agent.reasoning, runtime: agent.runtimeType, status: status.status !== 'open' ? 'offline' : status.inputReady === false || activity.state === 'attention' ? 'waiting' : activity.state === 'working' ? 'working' : ['ready', 'completed'].includes(activity.state) ? 'idle' : 'unknown' };
}

const activeMutations = new Set<string>();
export async function handleMobileRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  const mutating = ['send', 'setModel', 'replyQuestion', 'setPermissions', 'setAutoApprove'].includes(method);
  const key = mutating ? required(params.agentId) : '';
  if (mutating && activeMutations.has(key)) throw new Error('Another remote action is in progress for this agent.');
  if (mutating) activeMutations.add(key);
  try { return await executeMobileRequest(method, params); }
  finally { if (mutating) activeMutations.delete(key); }
}
async function executeMobileRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === 'session') return { connected: true, desktopName: 'AtrisAgent Desktop' };
  if (method === 'workspaces') {
    const workspaces = await apiRequest<Array<{ id: string; name: string }>>('/workspaces');
    return Promise.all(workspaces.map(async workspace => {
      const conversations = await apiRequest<ManualConversation[]>(`/manual/conversations?workspaceId=${encodeURIComponent(workspace.id)}`);
      return { id: workspace.id, name: workspace.name, agents: await Promise.all(conversations.flatMap(conversation => conversation.agents).map(agentView)) };
    }));
  }
  const { agent, workspaceId } = await findAgent(required(params.agentId));
  if (method === 'controls') {
    const transcript = await apiRequest<{ questions?: unknown[]; autoApprove?: unknown }>(`/manual/agents/${agent.id}/messages`);
    const permissions = agent.runtimeType === 'codex' ? await apiRequest(`/manual/agents/${agent.id}/permissions/live`) : undefined;
    const memory = await apiRequest<{ nodes: Array<{ id: string; title: string; summary: string }> }>(`/manual/conversations/${agent.conversationId}/memory?agentId=${agent.id}`).then(value => ({ nodes: value.nodes.slice(-30).map(node => ({ id: node.id, title: node.title, summary: node.summary.slice(0, 4000) })) })).catch(() => ({ nodes: [], unavailable: true }));
    return { questions: transcript.questions || [], autoApprove: transcript.autoApprove, permissions, preferredMode: agent.codexPermissionMode || null, memory };
  }
  if (method === 'replyQuestion') {
    if (!Array.isArray(params.answers) || params.answers.length > 20 || params.answers.some(answers => !Array.isArray(answers) || answers.length > 30 || answers.some(answer => typeof answer !== 'string' || answer.length > 4000))) throw new Error('Invalid answers.');
    return apiRequest(`/manual/agents/${agent.id}/questions/${encodeURIComponent(required(params.questionId))}/reply`, { method: 'POST', body: JSON.stringify({ answers: params.answers }) });
  }
  if (method === 'setAutoApprove') {
    if (agent.runtimeType !== 'opencode' || typeof params.enabled !== 'boolean') throw new Error('Unsupported permission mode.');
    const current = await apiRequest<{ autoApprove?: { available: boolean; enabled: boolean } }>(`/manual/agents/${agent.id}/messages`);
    if (!current.autoApprove?.available || current.autoApprove.enabled !== params.expectedEnabled) throw new Error('Permission mode changed. Refresh first.');
    return apiRequest(`/manual/agents/${agent.id}/auto-approve`, { method: 'POST', body: JSON.stringify({ enabled: params.enabled }) });
  }
  if (method === 'setPermissions') {
    if (agent.runtimeType !== 'codex' || !['ask-for-approval', 'approve-for-me', 'full-access', 'read-only'].includes(String(params.mode))) throw new Error('Unsupported permission mode.');
    return apiRequest(`/manual/agents/${agent.id}/permissions/live`, { method: 'POST', body: JSON.stringify({ mode: params.mode, runtimeId: params.runtimeId, threadId: params.threadId, revision: params.revision, expectedMode: params.expectedMode, fullAccessConfirmed: params.fullAccessConfirmed === true }) });
  }
  if (method === 'messages') {
    const result = await apiRequest<{ messages: ManualMessage[] }>(`/manual/agents/${agent.id}/messages`);
    // Bound encrypted responses to mobile-friendly pages. No raw CLI credentials.
    let remaining = 180_000;
    return result.messages.slice(-100).map(message => ({ id: message.id, role: message.role, text: message.text.length > 20_000 ? `[…earlier content omitted on mobile]\n${message.text.slice(-20_000)}` : message.text })).reverse().filter(message => { remaining -= new TextEncoder().encode(message.text).length; return remaining >= 0; }).reverse();
  }
  if (method === 'send') {
    if (params.workspaceId !== workspaceId || params.conversationId !== agent.conversationId) throw new Error('Agent context changed. Refresh the workspace.');
    return commands.send({ id: params.id, workspaceId, conversationId: agent.conversationId, agentId: agent.id, text: params.text });
  }
  if (method === 'models') return useAccountStore.getState().discoveredModels.filter(model => model.accountProfileId === agent.accountProfileId && model.runtimeType === agent.runtimeType).map(model => ({ id: model.catalogId, name: model.name, runtime: model.runtimeType, reasoning: model.supportedReasoning, available: model.available, selected: model.catalogId === agent.catalogId }));
  if (method === 'setModel') {
    // Other providers require restarting the existing native session, exactly
    // as desktop controls do. Never interrupt a running or waiting turn.
    const selected = useAccountStore.getState().discoveredModels.find(model => model.catalogId === params.modelId && model.accountProfileId === agent.accountProfileId && model.runtimeType === agent.runtimeType && model.available && model.availability === 'available');
    if (!selected || agent.catalogId !== params.expectedModelId) throw new Error('Model selection changed or is unavailable. Refresh first.');
    if (params.reasoning !== undefined && !selected.supportedReasoning.includes(params.reasoning as never)) throw new Error('Unsupported reasoning level.');
    if (agent.runtimeType !== 'opencode') {
      const activity = await apiRequest<{ state: string }>(`/manual/agents/${agent.id}/activity`);
      if (!['ready', 'completed'].includes(activity.state)) throw new Error('Wait until the current turn is confirmed idle before changing this CLI model.');
      await invoke('manual_terminal_close', { id: agent.id });
      await apiRequest(`/manual/agents/${agent.id}/coordination`, { method: 'DELETE' });
    }
    const updated = await apiRequest<ManualAgent>(`/manual/agents/${agent.id}/model`, { method: 'PATCH', body: JSON.stringify({ catalogId: required(params.modelId), expectedCatalogId: required(params.expectedModelId), reasoning: params.reasoning, live: true }) });
    if (agent.runtimeType !== 'opencode') {
      const request = await apiRequest<{ codexRuntimeId?: string }>(`/manual/agents/${agent.id}/launch`, { method: 'POST' });
      try { await invoke('manual_terminal_start', { request }); }
      catch (cause) {
        if (request.codexRuntimeId) await apiRequest(`/manual/agents/${agent.id}/codex-runtime`, { method: 'DELETE', body: JSON.stringify({ runtimeId: request.codexRuntimeId }) }).catch(() => {});
        await apiRequest(`/manual/agents/${agent.id}/coordination`, { method: 'DELETE' }).catch(() => {});
        throw cause;
      }
    }
    await useManualStore.getState().refresh(workspaceId);
    return agentView(updated);
  }
  throw new Error('Unsupported remote operation.');
}

export async function startMobileHost(token: string, relay = defaultRelay): Promise<void> {
  if (!isTauriRuntime()) { useMobileHost.setState({ status: 'error', error: 'Mobile access requires the installed desktop app.' }); return; }
  stopMobileHost(); const current = generation;
  const pairing = createPairing(relay);
  useMobileHost.setState({ status: 'connecting', error: '', expiresAt: pairing.expiresAt });
  const next = new RemoteHost(pairing, handleMobileRequest, devices => { if (current === generation) useMobileHost.setState({ devices }); }, undefined, () => {
    if (current === generation) useMobileHost.setState({ status: 'error', error: 'Relay disconnected. Enable mobile access again to reconnect.', code: '' });
  });
  host = next;
  try { await next.connect(token); if (current === generation) useMobileHost.setState({ status: 'online', code: encodePairing(pairing) }); }
  catch (cause) { if (current === generation) { next.close(); useMobileHost.setState({ status: 'error', error: cause instanceof Error ? cause.message : 'Could not connect to relay.', code: '' }); } }
}
export function approveMobile(id: string): void { host?.approve(id); }
export function revokeMobile(id: string): void { host?.disconnectDevice(id); }
export function stopMobileHost(): void { generation++; host?.close(); host = undefined; useMobileHost.setState({ status: 'disabled', code: '', error: '', devices: [], expiresAt: 0 }); }
