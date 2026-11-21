export interface AntigravitySubagentInfo {
  conversationId?: string;
  role?: string;
  typeName?: string;
  model?: string;
  state?: string;
}

export type AntigravityParsedEvent =
  | { kind: 'init'; conversationId?: string; transcriptPath?: string; raw: Record<string, any> }
  | {
      kind: 'step';
      stepIndex?: number;
      stepType: string;
      content: string;
      thinking?: string;
      toolName?: string;
      args?: Record<string, unknown>;
      output?: string;
      error?: string;
      state?: string;
      subagent?: AntigravitySubagentInfo;
      raw: Record<string, any>;
    }
  | {
      kind: 'result';
      success: boolean;
      content: string;
      error?: string;
      status?: string;
      finishedReason?: string;
      conversationId?: string;
      transcriptPath?: string;
      raw: Record<string, any>;
    }
  | { kind: 'unknown'; eventName?: string; raw: Record<string, any> }
  | { kind: 'malformed'; rawLine: string };

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, any> {
  const unwrapped = typeof value === 'string' ? unwrapAntigravityArg(value) : value;
  return unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)
    ? unwrapped as Record<string, any>
    : {};
}

function parseOutputRecord(rawOutput: string | undefined): Record<string, any> {
  if (!rawOutput) return {};
  const stripped = rawOutput.replace(/^(?:(?:Created At|Completed At):\s*[^\r\n]*\r?\n)+/i, '').trim();
  if (!stripped) return {};
  const direct = recordValue(stripped);
  if (Object.keys(direct).length > 0) return direct;
  const braceStart = stripped.indexOf('{');
  if (braceStart > 0) {
    return recordValue(stripped.slice(braceStart));
  }
  return {};
}

function nonEmptyRecord(...values: unknown[]): Record<string, any> {
  for (const value of values) {
    const record = recordValue(value);
    if (Object.keys(record).length > 0) return record;
  }
  return {};
}

export function unwrapAntigravityArg(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function unwrapAntigravityArgsRecord(record: Record<string, any>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = unwrapAntigravityArg(value);
  }
  return result;
}

export function parseAntigravityStreamLine(line: string): AntigravityParsedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'malformed', rawLine: line };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'malformed', rawLine: line };
  const envelope = parsed as Record<string, any>;

  const eventName = stringValue(envelope.event, envelope.type);
  if (eventName === 'init') {
    const init = recordValue(envelope.init);
    const transcriptPath = stringValue(envelope.transcript_path, init.transcript_path) || undefined;
    return {
      kind: 'init',
      conversationId: stringValue(envelope.conversation_id, envelope.session_id, init.conversation_id, init.session_id) || undefined,
      ...(transcriptPath ? { transcriptPath } : {}),
      raw: envelope,
    };
  }

  if (eventName === 'step_update') {
    const step = nonEmptyRecord(envelope.step_update, envelope);
    const nestedStep = recordValue(step.step);
    const toolInfo = recordValue(step.tool_info);
    const nestedToolInfo = recordValue(nestedStep.tool_info);
    const stepIndex = numberValue(step.step_index, nestedStep.step_index, envelope.step_index);
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
    const thinking = stringValue(
      step.thinking_delta,
      step.thought_delta,
      step.thinking,
      step.thought,
      nestedStep.thinking_delta,
      nestedStep.thought_delta,
      nestedStep.thinking,
      nestedStep.thought,
    ) || undefined;
    const toolName = stringValue(
      step.tool_name,
      toolInfo.name,
      toolInfo.tool_name,
      nestedStep.tool_name,
      nestedStep.name,
      nestedToolInfo.name,
      nestedToolInfo.tool_name,
    ) || undefined;
    const rawArgs = nonEmptyRecord(
      step.args,
      step.input,
      toolInfo.args,
      toolInfo.input,
      nestedStep.args,
      nestedStep.input,
      nestedToolInfo.args,
      nestedToolInfo.input,
    );
    const args = unwrapAntigravityArgsRecord(rawArgs);
    const output = stringValue(
      step.output,
      step.result,
      toolInfo.output,
      toolInfo.result,
      nestedStep.output,
      nestedStep.result,
    ) || undefined;
    const error = stringValue(
      step.error?.message,
      step.error,
      toolInfo.error?.message,
      toolInfo.error,
      nestedStep.error?.message,
      nestedStep.error,
    ) || undefined;
    const subagentInfo = nonEmptyRecord(
      step.subagent_info,
      nestedStep.subagent_info,
      toolInfo.subagent_info,
      nestedToolInfo.subagent_info,
    );
    const isSwarmAdd = toolName === 'swarm' && stringValue(args.action).toLowerCase() === 'add';
    const outputJson = (toolName === 'invoke_subagent' || isSwarmAdd) ? parseOutputRecord(output) : {};
    let subagent: AntigravitySubagentInfo | undefined;
    if (Object.keys(subagentInfo).length > 0 || toolName === 'invoke_subagent' || isSwarmAdd) {
      const conversationId = stringValue(
        subagentInfo.conversation_id,
        subagentInfo.conversationId,
        outputJson.conversation_id,
        outputJson.conversationId,
        args.conversationId,
        args.conversation_id,
      ) || undefined;
      const role = stringValue(
        subagentInfo.role,
        args.Role,
        args.role,
        isSwarmAdd ? stringValue(outputJson.name, args.name) : '',
      ) || undefined;
      const typeName = stringValue(
        subagentInfo.type_name,
        subagentInfo.typeName,
        args.TypeName,
        args.typeName,
        isSwarmAdd ? 'swarm' : '',
      ) || undefined;
      const model = stringValue(
        subagentInfo.model,
        outputJson.model_display_name,
        outputJson.model,
        args.Model,
        args.model,
        toolName === 'invoke_subagent' ? 'inherit' : '',
      ) || undefined;
      const subagentState = stringValue(subagentInfo.state, subagentInfo.status, outputJson.status) || undefined;
      subagent = {
        ...(conversationId ? { conversationId } : {}),
        ...(role ? { role } : {}),
        ...(typeName ? { typeName } : {}),
        ...(model ? { model } : {}),
        ...(subagentState ? { state: subagentState } : {}),
      };
    }
    return {
      kind: 'step',
      ...(stepIndex !== undefined ? { stepIndex } : {}),
      stepType,
      content,
      ...(thinking ? { thinking } : {}),
      toolName,
      args,
      ...(output ? { output } : {}),
      ...(error ? { error } : {}),
      state: stringValue(step.state, nestedStep.state) || undefined,
      ...(subagent ? { subagent } : {}),
      raw: envelope,
    };
  }

  if (eventName === 'result') {
    const result = nonEmptyRecord(envelope.result, envelope);
    const status = stringValue(result.status, envelope.status);
    const error = stringValue(result.error?.message, result.error, envelope.error?.message, envelope.error);
    const booleanSuccess = typeof result.success === 'boolean'
      ? result.success
      : typeof envelope.success === 'boolean' ? envelope.success : undefined;
    const explicitFailure = /^(?:error|failed|failure|cancelled|canceled)$/i.test(status);
    const explicitSuccess = /^(?:success|succeeded|completed|done)$/i.test(status);
    const success = booleanSuccess ?? (explicitSuccess ? true : explicitFailure || Boolean(error) ? false : undefined);
    if (success === undefined) return { kind: 'malformed', rawLine: line };
    const finishedReason = stringValue(result.finished_reason, result.finish_reason, envelope.finished_reason, envelope.finish_reason) || undefined;
    const conversationId = stringValue(result.conversation_id, result.session_id, envelope.conversation_id, envelope.session_id) || undefined;
    const transcriptPath = stringValue(result.transcript_path, envelope.transcript_path) || undefined;
    return {
      kind: 'result',
      success,
      content: stringValue(result.response, result.text, result.output, typeof result.result === 'string' ? result.result : undefined),
      error: error || undefined,
      status: status || undefined,
      ...(finishedReason ? { finishedReason } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      raw: envelope,
    };
  }

  return { kind: 'unknown', eventName: eventName || undefined, raw: envelope };
}
