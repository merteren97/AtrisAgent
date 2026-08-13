export type AntigravityParsedEvent =
  | { kind: 'init'; conversationId?: string; raw: Record<string, any> }
  | { kind: 'step'; stepType: string; content: string; toolName?: string; args?: Record<string, unknown>; state?: string; raw: Record<string, any> }
  | { kind: 'result'; success: boolean; content: string; error?: string; status?: string; raw: Record<string, any> }
  | { kind: 'unknown'; eventName?: string; raw: Record<string, any> }
  | { kind: 'malformed'; rawLine: string };

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function parseAntigravityStreamLine(line: string): AntigravityParsedEvent {
  let envelope: Record<string, any>;
  try {
    envelope = JSON.parse(line);
  } catch {
    return { kind: 'malformed', rawLine: line };
  }

  const eventName = stringValue(envelope.event, envelope.type);
  if (eventName === 'init') {
    const init = recordValue(envelope.init);
    return {
      kind: 'init',
      conversationId: stringValue(envelope.conversation_id, envelope.session_id, init.conversation_id, init.session_id) || undefined,
      raw: envelope,
    };
  }

  if (eventName === 'step_update') {
    const step = Object.keys(recordValue(envelope.step_update)).length
      ? recordValue(envelope.step_update)
      : envelope;
    const nestedStep = recordValue(step.step);
    const stepType = stringValue(step.step_type, nestedStep.type) || 'progress';
    const content = stringValue(
      step.text_delta,
      step.text,
      step.message,
      step.summary,
      nestedStep.text_delta,
      nestedStep.text,
      nestedStep.summary,
    );
    return {
      kind: 'step',
      stepType,
      content,
      toolName: stringValue(step.tool_name, nestedStep.tool_name) || undefined,
      args: recordValue(step.args || step.input || nestedStep.args || nestedStep.input),
      state: stringValue(step.state, nestedStep.state) || undefined,
      raw: envelope,
    };
  }

  if (eventName === 'result') {
    const result = Object.keys(recordValue(envelope.result)).length
      ? recordValue(envelope.result)
      : envelope;
    const status = stringValue(result.status, envelope.status);
    const error = stringValue(result.error?.message, result.error, envelope.error?.message, envelope.error);
    const explicitFailure = result.success === false || /^(?:error|failed|failure|cancelled|canceled)$/i.test(status);
    const explicitSuccess = result.success === true || /^(?:success|succeeded|completed|done)$/i.test(status);
    return {
      kind: 'result',
      success: explicitSuccess || (!explicitFailure && !error),
      content: stringValue(result.response, result.text, result.output, typeof result.result === 'string' ? result.result : undefined),
      error: error || undefined,
      status: status || undefined,
      raw: envelope,
    };
  }

  return { kind: 'unknown', eventName: eventName || undefined, raw: envelope };
}
