import type { RemoteMessageHost } from './remote-agent-commands';

export interface RemoteAgentHostDependencies {
  conversations(workspaceId: string): Promise<Array<{ id: string; workspaceId: string; agents: Array<{ id: string; conversationId: string }> }>>;
  terminalStatus(agentId: string): Promise<{ status: string; inputReady?: boolean | null }>;
  writeMessage(agentId: string, text: string): Promise<void>;
}

/** Binds remote message delivery to an existing manual conversation and live terminal. */
export function createRemoteAgentHost(dependencies: RemoteAgentHostDependencies): RemoteMessageHost {
  return {
    async deliver(command) {
      const conversations = await dependencies.conversations(command.workspaceId);
      const conversation = conversations.find(item => item.id === command.conversationId && item.workspaceId === command.workspaceId);
      if (!conversation?.agents.some(agent => agent.id === command.agentId && agent.conversationId === command.conversationId)) return 'unavailable';
      const terminal = await dependencies.terminalStatus(command.agentId);
      if (terminal.status !== 'open' || terminal.inputReady === false) return 'unavailable';
      await dependencies.writeMessage(command.agentId, command.text);
      return 'delivered';
    },
  };
}
