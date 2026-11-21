import { useManualStore, type ManualAgent } from '@/stores/manual-store';

interface ManualAttachmentTransport {
  stage: (id: string, file: File) => Promise<string>;
  write: (id: string, prompt: string) => Promise<void>;
}

const inFlight = new Map<string, Promise<void>>();

/** Delivery outlives the workspace view; only an accepted write consumes its snapshot. */
export function sendManualDraft(agent: Pick<ManualAgent, 'id' | 'conversationId'>, transport: ManualAttachmentTransport): Promise<void> {
  const pending = inFlight.get(agent.id);
  if (pending) return pending;
  const delivery = deliverManualDraft(agent, transport);
  inFlight.set(agent.id, delivery);
  const finished = () => { if (inFlight.get(agent.id) === delivery) inFlight.delete(agent.id); };
  void delivery.then(finished, finished);
  return delivery;
}

async function deliverManualDraft(agent: Pick<ManualAgent, 'id' | 'conversationId'>, transport: ManualAttachmentTransport): Promise<void> {
  const exists = () => Object.values(useManualStore.getState().conversations).some(items => items.some(c => c.id === agent.conversationId && c.agents.some(item => item.id === agent.id)));
  if (!exists()) return;
  const current = useManualStore.getState();
  const draft = current.drafts[agent.id] || '';
  const files = current.attachments[agent.id] || [];
  const text = draft.trim();
  if (!text && !files.length) return;
  const staged = await Promise.all(files.map(async file => ({ name: file.name, path: await transport.stage(agent.id, file) })));
  const references = staged.map(({ name, path }) => `- ${JSON.stringify(name)}: ${JSON.stringify(path)}`).join('\n');
  const prompt = staged.length ? `${text}${text ? '\n\n' : ''}Attached files (read these local paths to inspect their contents, including images):\n${references}` : text;
  // Navigation is safe; deletion while staging must not send to a removed agent.
  if (!exists()) return;
  await transport.write(agent.id, prompt);
  useManualStore.getState().clearSentDraft(agent.id, draft, files);
}
