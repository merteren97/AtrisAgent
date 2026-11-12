/**
 * Transport-independent building block for remote manual-agent delivery.
 * The caller MUST authenticate and authorize the device before calling this
 * class. This is not an HTTP endpoint and does not provide authentication.
 * Receipts are scoped to the lifetime of this instance and are not durable.
 */
export interface RemoteMessageCommand {
  id: string;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  text: string;
}

export type RemoteMessageResult =
  | { status: 'delivered' }
  | { status: 'rejected'; reason: 'invalid' | 'unavailable' | 'busy' | 'conflict' | 'capacity' }
  | { status: 'unknown' };

export interface RemoteMessageHost {
  /** Check membership and readiness immediately before writing to the terminal. */
  deliver(command: RemoteMessageCommand): Promise<'delivered' | 'unavailable'>;
}

interface Receipt {
  command: RemoteMessageCommand;
  result: Promise<RemoteMessageResult>;
}

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && /^[a-zA-Z0-9_-]+$/.test(value);

function parseCommand(value: unknown): RemoteMessageCommand | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const command = value as Record<string, unknown>;
  if (Object.keys(command).some(key => !['id', 'workspaceId', 'conversationId', 'agentId', 'text'].includes(key))) return;
  if (!identifier(command.id) || !identifier(command.workspaceId) || !identifier(command.conversationId) || !identifier(command.agentId)) return;
  if (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 32000) return;
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(command.text)) return;
  return { id: command.id, workspaceId: command.workspaceId, conversationId: command.conversationId, agentId: command.agentId, text: command.text };
}

function sameCommand(a: RemoteMessageCommand, b: RemoteMessageCommand): boolean {
  return a.workspaceId === b.workspaceId && a.conversationId === b.conversationId && a.agentId === b.agentId && a.text === b.text;
}

export class RemoteAgentCommands {
  private readonly receipts = new Map<string, Receipt>();
  private readonly activeAgents = new Set<string>();

  constructor(private readonly host: RemoteMessageHost, private readonly maxReceipts = 1024) {}

  /**
   * One write per command ID while this instance lives. Do not automatically
   * retry an `unknown` result: the terminal may already have received it.
   */
  send(input: unknown): Promise<RemoteMessageResult> {
    const command = parseCommand(input);
    if (!command) return Promise.resolve({ status: 'rejected', reason: 'invalid' });
    const receipt = this.receipts.get(command.id);
    if (receipt) return sameCommand(receipt.command, command)
      ? receipt.result
      : Promise.resolve({ status: 'rejected', reason: 'conflict' });
    if (this.receipts.size >= this.maxReceipts) return Promise.resolve({ status: 'rejected', reason: 'capacity' });
    if (this.activeAgents.has(command.agentId)) return Promise.resolve({ status: 'rejected', reason: 'busy' });

    this.activeAgents.add(command.agentId);
    // The microtask makes the receipt visible before host code can run.
    const result: Promise<RemoteMessageResult> = Promise.resolve().then(async () => {
      try {
        const outcome = await this.host.deliver(command);
        return outcome === 'delivered' ? { status: 'delivered' } : { status: 'rejected', reason: 'unavailable' };
      } catch {
        // A write may have succeeded before its acknowledgment was lost.
        return { status: 'unknown' };
      } finally {
        this.activeAgents.delete(command.agentId);
      }
    });
    this.receipts.set(command.id, { command, result });
    return result;
  }
}
