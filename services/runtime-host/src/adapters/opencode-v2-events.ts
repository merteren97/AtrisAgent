type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

/** Convert a session-scoped v2 event into the adapter's internal event format. */
export function normalizeV2Event(raw: unknown, toolName?: string) {
  const event = object(raw);
  const data = object(event?.data);
  if (!event || !data) return;

  if (event.type === 'form.created') {
    const form = object(data.form) || data;
    const sessionID = typeof form.sessionID === 'string' ? form.sessionID : '';
    const id = typeof form.id === 'string' ? form.id : '';
    if (!sessionID || !id || !Array.isArray(form.fields)) return;
    return {
      type: 'form.created',
      properties: {
        sessionID,
        id,
        title: typeof form.title === 'string' ? form.title : 'Question',
        fields: form.fields,
      },
    };
  }

  if (typeof data.sessionID !== 'string' || !data.sessionID) return;
  const sessionID = data.sessionID;
  const wrap = (type: string, fields: JsonObject = {}) => ({ type, properties: { sessionID, ...fields } });

  switch (event.type) {
    case 'session.text.delta':
    case 'session.reasoning.delta':
      if (typeof data.delta !== 'string' || !data.delta) return;
      return wrap('message.part.updated', {
        delta: data.delta,
        part: { type: event.type === 'session.text.delta' ? 'text' : 'reasoning' },
      });
    case 'session.tool.called':
    case 'session.tool.success':
    case 'session.tool.failed': {
      if (typeof data.id !== 'string' || !data.id) return;
      const resolvedTool = (typeof data.tool === 'string' && data.tool)
        || (typeof data.name === 'string' && data.name)
        || toolName;
      const state = event.type === 'session.tool.called' ? { status: 'running', input: object(data.input) }
        : event.type === 'session.tool.success' ? { status: 'completed', output: data.content }
        : { status: 'error', error: object(data.error)?.message || 'OpenCode tool failed' };
      return wrap('message.part.updated', { part: { type: 'tool', id: data.id, tool: resolvedTool, state } });
    }
    case 'permission.asked':
      if (typeof data.id !== 'string' || !data.id || typeof data.action !== 'string') return;
      return wrap('permission.asked', { id: data.id, type: data.action, title: data.message, metadata: data.metadata });
    case 'form.replied':
      if (typeof data.id !== 'string' || !data.id) return;
      return wrap('question.replied', { requestID: data.id, answers: Array.isArray(data.answers) ? data.answers : [] });
    case 'form.cancelled':
      if (typeof data.id !== 'string' || !data.id) return;
      return wrap('question.rejected', { requestID: data.id });
    case 'session.usage.updated':
      // These are session totals. Replace the previous snapshot under the same key.
      return wrap('message.updated', { info: { id: sessionID, tokens: data.tokens, cost: data.cost } });
    case 'session.execution.succeeded':
      return wrap('session.idle');
    case 'session.execution.failed':
      return wrap('session.error', { error: object(data.error)?.message || 'OpenCode session failed' });
    case 'session.execution.interrupted':
      return wrap('session.error', { error: typeof data.reason === 'string' ? `OpenCode session interrupted (${data.reason})` : 'OpenCode session interrupted' });
  }
}
