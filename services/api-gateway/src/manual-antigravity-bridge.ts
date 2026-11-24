import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { unwrapAntigravityArg, unwrapAntigravityArgsRecord } from '@atris-agent-code/runtime-host';
import { readTail } from './manual-provider-bridge';
import type { ManualAgent, ManualMessage, ManualQuestion } from './manual-conversations';

export interface ManualToolSubagent {
  conversationId?: string;
  role?: string;
  typeName?: string;
  model?: string;
}

export interface ManualToolArtifact {
  path: string;
  title: string;
  summary?: string;
  content?: string;
  requestFeedback?: boolean;
}

export interface ManualToolItem {
  id: string;
  name: string;
  summary: string;
  detail?: string;
  output?: string;
  status: 'running' | 'completed' | 'failed';
  subagent?: ManualToolSubagent;
  artifact?: ManualToolArtifact;
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const UUID_FINDER = /\b([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\b/i;
interface Binding { launchId: string; sessionId?: string }
interface CachedTranscript { mtimeMs: number; size: number; truncated: boolean; parsed: ParsedTranscriptState }
const TRANSCRIPT_CACHE = new Map<string, CachedTranscript>();
const TRANSCRIPT_CACHE_LIMIT = 32;

function readParsedTranscript(filename: string, sessionId: string): { parsed: ParsedTranscriptState; truncated: boolean; mtimeIso?: string } {
  let stat: fs.Stats | undefined;
  try { stat = fs.statSync(filename); } catch {}
  const key = `${filename}\u0000${sessionId}`;
  if (stat) {
    const cached = TRANSCRIPT_CACHE.get(key);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      TRANSCRIPT_CACHE.delete(key);
      TRANSCRIPT_CACHE.set(key, cached);
      return { parsed: cached.parsed, truncated: cached.truncated, mtimeIso: stat.mtime.toISOString() };
    }
  }
  const tail = readTail(filename);
  const parsed = parseTranscriptInternal(tail.source, sessionId);
  if (stat) {
    TRANSCRIPT_CACHE.delete(key);
    TRANSCRIPT_CACHE.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, truncated: tail.truncated, parsed });
    if (TRANSCRIPT_CACHE.size > TRANSCRIPT_CACHE_LIMIT) {
      const oldest = TRANSCRIPT_CACHE.keys().next().value;
      if (oldest) TRANSCRIPT_CACHE.delete(oldest);
    }
  }
  return { parsed, truncated: tail.truncated, mtimeIso: stat?.mtime.toISOString() };
}

function basenameAny(filePath: string): string {
  return filePath.includes('\\') ? path.win32.basename(filePath) : path.basename(filePath);
}

export function stripAntigravityResultHeaders(content: string): string {
  return content
    .replace(/^(?:(?:Created At|Completed At):\s*[^\r\n]*\r?\n?)+/i, '')
    .trim();
}

function parseGenericResultJson(content: string): Record<string, any> | undefined {
  const cleaned = stripAntigravityResultHeaders(content);
  if (!cleaned) return undefined;
  const tryParse = (candidate: string): Record<string, any> | undefined => {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, any>
        : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(cleaned);
  if (direct) return direct;
  const braceIndex = cleaned.indexOf('{');
  if (braceIndex > 0) {
    return tryParse(cleaned.slice(braceIndex));
  }
  return undefined;
}

function userRequestText(content: string): string {
  // The CLI records a prompt envelope, not just what was typed. Only unwrap a
  // complete envelope with recognized trailing metadata; never strip arbitrary
  // XML/Markdown from a user's request or from an assistant's response.
  const envelope = /^\s*<USER_REQUEST>\s*\n?([\s\S]*)<\/USER_REQUEST>([\s\S]*)$/.exec(content);
  if (!envelope) return content;
  const metadata = /\s*<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|USERSETTINGSCHANGE)>[\s\S]*?<\/\1>\s*/y;
  const suffix = envelope[2];
  let offset = 0;
  while (suffix.slice(offset).trim()) {
    metadata.lastIndex = offset;
    if (!metadata.exec(suffix)) return content;
    offset = metadata.lastIndex;
  }
  return envelope[1].trim();
}

export function parseAntigravityQuestions(rawQuestions: unknown, id: string): ManualQuestion | undefined {
  let value = unwrapAntigravityArg(rawQuestions);
  if (typeof value === 'string') value = unwrapAntigravityArg(value);
  const rawList = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).questions)
      ? (value as Record<string, unknown>).questions as unknown[]
      : null;
  if (!rawList || rawList.length === 0) return undefined;

  const validEntries = rawList.filter((entry): entry is Record<string, any> =>
    Boolean(entry && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as any).question === 'string' && (Array.isArray((entry as any).options) || (entry as any).custom !== false)),
  );
  if (validEntries.length === 0) return undefined;

  const questions: ManualQuestion['questions'] = validEntries.map((entry, idx) => {
    const options: Array<{ label: string; description?: string }> = [];
    for (const option of (Array.isArray(entry.options) ? entry.options : []) as unknown[]) {
      if (typeof option === 'string') {
        if (option.trim()) options.push({ label: option });
      } else if (option && typeof option === 'object' && !Array.isArray(option)) {
        const optRecord = option as Record<string, unknown>;
        const label = typeof optRecord.label === 'string'
          ? optRecord.label
          : typeof optRecord.text === 'string'
            ? optRecord.text
            : undefined;
        if (label) {
          options.push({
            label,
            ...(typeof optRecord.description === 'string' ? { description: optRecord.description } : {}),
          });
        }
      }
    }
    const header = typeof entry.header === 'string' && entry.header.trim()
      ? entry.header
      : validEntries.length > 1
        ? `Question ${idx + 1}/${validEntries.length}`
        : '';
    return {
      header,
      question: entry.question,
      options,
      multiple: Boolean(entry.is_multi_select ?? entry.multiple ?? entry.multiSelect),
      custom: entry.custom !== false,
    };
  });

  return questions.length ? { id, questions } : undefined;
}

export function buildAntigravityToolItem(
  toolName: string,
  rawArgs: Record<string, any>,
  options: {
    id: string;
    status: ManualToolItem['status'];
    output?: string;
    subagentId?: string;
    question?: ManualQuestion;
  },
): ManualToolItem {
  const args = unwrapAntigravityArgsRecord(rawArgs);
  const filePath = typeof args.Path === 'string'
    ? args.Path
    : typeof args.path === 'string'
      ? args.path
      : '';
  let summary = typeof args.toolSummary === 'string' && args.toolSummary.trim()
    ? args.toolSummary.trim().slice(0, 160)
    : toolName;
  let detail: string | undefined;
  let subagent: ManualToolSubagent | undefined;
  let artifact: ManualToolArtifact | undefined;
  const resultJson = options.output ? parseGenericResultJson(options.output) : undefined;

  if (toolName === 'invoke_subagent') {
    const rawModel = typeof args.Model === 'string' && args.Model.trim()
      ? args.Model.trim()
      : typeof args.model === 'string' && args.model.trim()
        ? args.model.trim()
        : undefined;
    const friendlyModel = rawModel || 'inherit';
    const role = typeof args.Role === 'string' && args.Role.trim()
      ? args.Role.trim()
      : typeof args.TypeName === 'string' && args.TypeName.trim()
        ? args.TypeName.trim()
        : 'Subagent';
    const typeName = typeof args.TypeName === 'string' && args.TypeName.trim() ? args.TypeName.trim() : undefined;
    const jsonConvId = typeof resultJson?.conversationId === 'string'
      ? resultJson.conversationId
      : typeof resultJson?.conversation_id === 'string'
        ? resultJson.conversation_id
        : typeof resultJson?.result?.conversationId === 'string'
          ? resultJson.result.conversationId
          : undefined;
    const conversationId = options.subagentId
      || jsonConvId
      || (typeof args.conversationId === 'string' && args.conversationId.trim() ? args.conversationId.trim() : undefined);
    summary = `${role} (${friendlyModel})`;
    detail = typeof args.Prompt === 'string' && args.Prompt.trim() ? args.Prompt.trim().slice(0, 240) : undefined;
    subagent = {
      ...(conversationId ? { conversationId } : {}),
      role,
      ...(typeName ? { typeName } : {}),
      model: friendlyModel,
    };
  } else if (toolName === 'run_command') {
    summary = String(args.toolSummary || args.CommandLine || 'Run command').slice(0, 160);
    detail = typeof args.CommandLine === 'string' ? args.CommandLine.slice(0, 240) : undefined;
  } else if (toolName === 'read_file') {
    summary = filePath ? `Read ${basenameAny(filePath)}` : 'Read file';
    detail = filePath || undefined;
  } else if (toolName === 'edit_file') {
    summary = filePath ? `Edit ${basenameAny(filePath)}` : 'Edit file';
    detail = filePath || undefined;
  } else if (toolName === 'write_file') {
    summary = filePath ? `Write ${basenameAny(filePath)}` : 'Write file';
    detail = filePath || undefined;
    const artifactMeta = args.ArtifactMetadata && typeof args.ArtifactMetadata === 'object' && !Array.isArray(args.ArtifactMetadata)
      ? args.ArtifactMetadata as Record<string, any>
      : undefined;
    const isArtifact = Boolean(artifactMeta) || (filePath.toLowerCase().endsWith('.md') && /(?:^|[\\/])brain[\\/]/i.test(filePath));
    if (isArtifact) {
      artifact = {
        path: filePath,
        title: basenameAny(filePath || 'artifact.md'),
        ...(typeof artifactMeta?.Summary === 'string' ? { summary: artifactMeta.Summary } : {}),
        ...(typeof args.Content === 'string' ? { content: args.Content } : {}),
        requestFeedback: Boolean(artifactMeta?.RequestFeedback),
      };
    }
  } else if (toolName === 'ask_question') {
    summary = options.question
      ? `Asked ${options.question.questions.length} question${options.question.questions.length === 1 ? '' : 's'}`
      : 'Asked question';
  } else if (toolName === 'send_message') {
    summary = args.Recipient ? `Message ${String(args.Recipient).slice(0, 36)}` : 'Send message';
    detail = typeof args.Message === 'string' && args.Message.trim() ? args.Message.trim().slice(0, 240) : undefined;
  } else if (toolName === 'search_web') {
    summary = args.query ? `Search "${String(args.query).slice(0, 120)}"` : 'Search web';
  } else if (toolName === 'swarm') {
    const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
    if (action === 'add') {
      const baseName = String(resultJson?.name || args.name || 'Swarm worker').trim();
      const count = Array.isArray(args.tasks) && args.tasks.length > 1
        ? args.tasks.length
        : typeof args.n === 'number' && args.n > 1
          ? args.n
          : undefined;
      const role = count ? `${baseName} (×${count})` : baseName;
      const modelDisplay = String(
        resultJson?.model_display_name || resultJson?.model || args.model || 'inherit',
      ).trim();
      const workspace = typeof args.workspace === 'string' && args.workspace.trim() && args.workspace.trim() !== 'inherit'
        ? args.workspace.trim()
        : undefined;
      const typeName = workspace ? `swarm · ${workspace}` : 'swarm';
      const conversationId = options.subagentId
        || (typeof resultJson?.conversation_id === 'string' ? resultJson.conversation_id : undefined)
        || (typeof resultJson?.conversationId === 'string' ? resultJson.conversationId : undefined)
        || (typeof args.conversationId === 'string' && args.conversationId.trim() ? args.conversationId.trim() : undefined);
      summary = `${role} (${modelDisplay})`;
      detail = typeof args.brief === 'string' && args.brief.trim() ? args.brief.trim().slice(0, 240) : undefined;
      subagent = {
        ...(conversationId ? { conversationId } : {}),
        role,
        typeName,
        model: modelDisplay,
      };
    } else if (action === 'title') {
      summary = args.title ? `Swarm title: ${String(args.title).slice(0, 120)}` : 'Swarm title';
    } else if (action === 'status') {
      const memberCount = Array.isArray(resultJson?.members) ? resultJson.members.length : undefined;
      summary = memberCount !== undefined ? `Swarm status (${memberCount} members)` : 'Swarm status';
    } else if (action === 'kill') {
      summary = args.name ? `Swarm kill: ${String(args.name)}` : 'Swarm kill';
    } else if (action === 'model') {
      const target = resultJson?.name || args.name;
      const nextModel = resultJson?.model_display_name || resultJson?.model || args.model;
      summary = `Swarm model${target ? `: ${String(target)}` : ''}${nextModel ? ` -> ${String(nextModel)}` : ''}`;
    } else if (action === 'models') {
      summary = `List swarm models${args.all ? ' (all)' : ''}`;
    } else {
      summary = action ? `Swarm ${action}${args.name ? ` (${String(args.name)})` : ''}` : 'Swarm';
    }
  } else if (toolName === 'call_mcp_tool') {
    const server = String(args.ServerName ?? args.serverName ?? args.server_name ?? '').trim();
    const tool = String(args.ToolName ?? args.toolName ?? args.tool_name ?? '').trim();
    summary = server && tool
      ? `${server}: ${tool}`
      : tool
        ? `MCP: ${tool}`
        : server
          ? `MCP: ${server}`
          : 'Call MCP tool';
    const rawMcpArgs = unwrapAntigravityArg(args.Arguments ?? args.arguments);
    // Only display known chat text; arbitrary tool arguments may contain credentials.
    if (server === 'atris_workspace' && tool === 'workspace_send_message' && rawMcpArgs && typeof rawMcpArgs === 'object' && !Array.isArray(rawMcpArgs)) {
      const mcpArgs = rawMcpArgs as Record<string, any>;
      const preview = mcpArgs.body;
      if (typeof preview === 'string' && preview.trim()) {
        detail = preview.trim().slice(0, 240);
      }
    }
  } else if (toolName === 'read_board') {
    if (args.status) {
      summary = 'Read swarm status';
    } else if (Array.isArray(args.seqs) && args.seqs.length > 0) {
      summary = `Read board (${args.seqs.map((s: unknown) => `#${String(s)}`).join(', ')})`;
    } else if (args.since !== undefined) {
      summary = `Read board (since #${String(args.since)})`;
    } else {
      summary = 'Read swarm board';
    }
  } else if (toolName === 'post_message') {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    const mention = /^(@[a-z0-9_-]+)/i.exec(text)?.[1];
    summary = mention ? `Post to ${mention}` : 'Post to swarm board';
    detail = text ? text.slice(0, 240) : undefined;
  } else if (toolName === 'swarm_wait') {
    summary = `Wait for board${args.since !== undefined ? ` (after #${String(args.since)})` : ''}`;
    detail = args.mentions_only === false ? 'All board messages' : 'Waiting for @mention or @all';
  } else if (toolName === 'run_workflow') {
    summary = typeof args.Description === 'string' && args.Description.trim()
      ? args.Description.trim().slice(0, 120)
      : typeof args.ScriptPath === 'string' && args.ScriptPath.trim()
        ? `Run workflow ${basenameAny(args.ScriptPath.trim())}`
        : 'Run workflow';
    detail = (typeof args.ScriptPath === 'string' && args.ScriptPath.trim())
      || (typeof args.Cwd === 'string' && args.Cwd.trim())
      || undefined;
  } else if (toolName === 'list_resources') {
    summary = args.ServerName ? `List resources (${String(args.ServerName)})` : 'List MCP resources';
  } else if (toolName === 'read_resource') {
    summary = args.Uri
      ? `Read resource ${basenameAny(String(args.Uri))}`
      : args.ServerName
        ? `Read resource (${String(args.ServerName)})`
        : 'Read MCP resource';
    detail = typeof args.Uri === 'string' && args.Uri.trim() ? args.Uri.trim() : undefined;
  } else if (toolName === 'manage_subagents') {
    summary = args.Action ? `Subagents: ${String(args.Action)}` : 'Manage subagents';
  } else if (toolName === 'manage_task') {
    summary = args.Action ? `Task: ${String(args.Action)}` : 'Manage task';
  } else if (toolName === 'define_subagent') {
    summary = args.Name ? `Define subagent ${String(args.Name)}` : 'Define subagent';
  } else if (toolName === 'schedule') {
    summary = args.CronExpression
      ? `Schedule ${String(args.CronExpression)}`
      : args.DurationSeconds
        ? `Timer ${String(args.DurationSeconds)}s`
        : 'Schedule';
  }

  return {
    id: options.id,
    name: toolName,
    summary,
    ...(detail ? { detail } : {}),
    ...(options.output ? { output: options.output } : {}),
    status: options.status,
    ...(subagent ? { subagent } : {}),
    ...(artifact ? { artifact } : {}),
  };
}

interface ParsedTranscriptState {
  messages: ManualMessage[];
  questions: ManualQuestion[];
  steps: Map<number, any>;
  sortedSteps: Array<[number, any]>;
  completedSubagents: Set<string>;
  hasRunningSubagent: boolean;
}

function parseTranscriptInternal(source: string, sessionId: string): ParsedTranscriptState {
  const steps = new Map<number, any>();
  const completedSubagents = new Set<string>();
  const lastSystemSenderStep = new Map<string, number>();
  const killedSwarmWorkers = new Set<string>();
  const lastMentionPostStep = new Map<string, number>();

  for (const line of source.split('\n')) {
    let item: any;
    try { item = JSON.parse(line); } catch { continue; }
    if (!item || typeof item !== 'object' || !Number.isInteger(item.step_index) || item.step_index < 0) continue;
    steps.set(item.step_index, item);
    if (item.type === 'SYSTEM_MESSAGE' && typeof item.content === 'string') {
      for (const match of item.content.matchAll(/\bsender=([a-f0-9-]{36})\b/gi)) {
        const senderId = match[1].toLowerCase();
        completedSubagents.add(senderId);
        const prev = lastSystemSenderStep.get(senderId) ?? -1;
        if (item.step_index > prev) lastSystemSenderStep.set(senderId, item.step_index);
      }
    }
  }

  const sortedSteps = [...steps.entries()].sort(([a], [b]) => a - b);
  for (const [stepIdx, step] of sortedSteps) {
    if (step.type !== 'PLANNER_RESPONSE' || step.source !== 'MODEL' || !Array.isArray(step.tool_calls)) continue;
    step.tool_calls.forEach((call: any, callIdx: number) => {
      const name = typeof call?.name === 'string' ? call.name.trim() : '';
      const rawArgs = call?.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {};
      const args = unwrapAntigravityArgsRecord(rawArgs);
      const resultStep = steps.get(stepIdx + 1 + callIdx);
      if (name === 'swarm') {
        const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
        if (action === 'kill' && typeof args.name === 'string' && args.name.trim() && resultStep?.status !== 'ERROR') {
          killedSwarmWorkers.add(args.name.trim().toLowerCase());
        } else if (action === 'status' && typeof resultStep?.content === 'string') {
          const statusJson = parseGenericResultJson(resultStep.content);
          if (Array.isArray(statusJson?.members)) {
            for (const member of statusJson.members) {
              if (member && typeof member === 'object' && member.killed === true && typeof member.name === 'string') {
                killedSwarmWorkers.add(member.name.trim().toLowerCase());
              }
            }
          }
        }
      } else if (name === 'post_message' && typeof args.text === 'string') {
        for (const match of args.text.matchAll(/@([a-z0-9_-]+)/gi)) {
          const mention = match[1].toLowerCase();
          lastMentionPostStep.set(mention, stepIdx);
        }
      }
    });
  }

  const finalPlannerStepIndices = sortedSteps
    .filter(([, step]) => step.type === 'PLANNER_RESPONSE' && step.source === 'MODEL' && step.status === 'DONE'
      && (!Array.isArray(step.tool_calls) || step.tool_calls.length === 0))
    .map(([index]) => index);
  const lastFinalPlannerIndex = finalPlannerStepIndices.at(-1) ?? -1;

  const messages: ManualMessage[] = [];
  const unresolvedQuestions = new Map<number, ManualQuestion[]>();
  let hasRunningSubagent = false;

  for (const [stepIndex, item] of sortedSteps) {
    if (item.type === 'USER_INPUT' && item.source === 'USER_EXPLICIT' && item.status === 'DONE') {
      if (typeof item.content !== 'string') continue;
      const text = userRequestText(item.content);
      if (!text.trim()) continue;
      unresolvedQuestions.clear();
      messages.push({ id: `${sessionId}:${stepIndex}`, role: 'user', text });
      continue;
    }

    if (item.type === 'PLANNER_RESPONSE' && item.source === 'MODEL' && item.status === 'DONE') {
      const text = typeof item.content === 'string' ? item.content : '';
      const thinking = typeof item.thinking === 'string' && item.thinking.trim() ? item.thinking.trim() : undefined;
      const thinkingTokens = thinking && typeof item.output_tokens === 'number' ? item.output_tokens : undefined;
      const model = typeof item.model === 'string' && item.model.trim() ? item.model.trim() : undefined;
      const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
      const hasLaterFinalPlannerResponse = lastFinalPlannerIndex > stepIndex;

      if (toolCalls.length === 0) {
        if (!text.trim() && !thinking) continue;
        unresolvedQuestions.clear();
        messages.push({
          id: `${sessionId}:${stepIndex}`,
          role: 'assistant',
          text,
          ...(thinking ? { thinking } : {}),
          ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
          ...(model ? { model } : {}),
        });
        continue;
      }

      const tools: ManualToolItem[] = [];
      const stepToolMessages: ManualMessage[] = [];
      const stepPendingQuestions: ManualQuestion[] = [];

      toolCalls.forEach((call: any, callIndex: number) => {
        const toolName = typeof call?.name === 'string' && call.name.trim() ? call.name.trim() : 'Tool';
        const rawArgs = call?.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {};
        const args = unwrapAntigravityArgsRecord(rawArgs);
        const resultStepIndex = stepIndex + 1 + callIndex;
        const candidateResult = steps.get(resultStepIndex);
        const resultStep = candidateResult?.type === 'GENERIC' ? candidateResult : undefined;
        const question = toolName === 'ask_question'
          ? parseAntigravityQuestions(args.questions, `${sessionId}:question:${stepIndex}:${callIndex}`)
          : undefined;

        const resultContent = typeof resultStep?.content === 'string' ? resultStep.content : '';
        const cleanedResultContent = stripAntigravityResultHeaders(resultContent);
        const resultJson = cleanedResultContent ? parseGenericResultJson(cleanedResultContent) : undefined;
        const isSwarmAdd = toolName === 'swarm' && typeof args.action === 'string' && args.action.trim().toLowerCase() === 'add';
        const jsonConversationId = typeof resultJson?.conversation_id === 'string'
          ? resultJson.conversation_id
          : typeof resultJson?.conversationId === 'string'
            ? resultJson.conversationId
            : typeof resultJson?.result?.conversationId === 'string'
              ? resultJson.result.conversationId
              : undefined;
        const subagentIdMatch = (toolName === 'invoke_subagent' || isSwarmAdd)
          ? (typeof args.conversationId === 'string' && UUID.test(args.conversationId)
            ? args.conversationId
            : (jsonConversationId && UUID.test(jsonConversationId) ? jsonConversationId : UUID_FINDER.exec(cleanedResultContent)?.[1]))
          : undefined;

        let status: ManualToolItem['status'];
        if (resultStep?.status === 'ERROR') {
          status = 'failed';
        } else if (toolName === 'invoke_subagent') {
          if ((subagentIdMatch && completedSubagents.has(subagentIdMatch.toLowerCase())) || hasLaterFinalPlannerResponse) {
            status = 'completed';
          } else {
            status = 'running';
            hasRunningSubagent = true;
          }
        } else if (isSwarmAdd) {
          const workerName = String(resultJson?.name || args.name || '').trim().toLowerCase();
          const lastWakeStep = Math.max(
            stepIndex,
            workerName ? (lastMentionPostStep.get(workerName) ?? -1) : -1,
            lastMentionPostStep.get('all') ?? -1,
          );
          const senderDoneAfterWake = Boolean(
            subagentIdMatch && (lastSystemSenderStep.get(subagentIdMatch.toLowerCase()) ?? -1) > lastWakeStep,
          );
          const workerKilled = Boolean(workerName && killedSwarmWorkers.has(workerName));
          if (senderDoneAfterWake || workerKilled || hasLaterFinalPlannerResponse) {
            status = 'completed';
          } else {
            status = 'running';
            hasRunningSubagent = true;
          }
        } else {
          status = resultStep?.status === 'DONE' ? 'completed' : 'running';
        }

        const output = resultStep && (resultStep.status === 'DONE' || resultStep.status === 'ERROR') && cleanedResultContent
          ? cleanedResultContent.slice(0, 4000)
          : undefined;
        const toolId = typeof call?.id === 'string' && call.id.trim()
          ? call.id.trim()
          : `${sessionId}:${stepIndex}:tool:${callIndex}`;

        const toolItem = buildAntigravityToolItem(toolName, rawArgs, {
          id: toolId,
          status,
          output,
          subagentId: subagentIdMatch,
          question,
        });
        tools.push(toolItem);

        stepToolMessages.push({
          id: `${sessionId}:${stepIndex}:tool:${callIndex}`,
          role: 'tool',
          text: toolItem.summary,
          toolName,
          ...(question ? { question } : {}),
        });

        if (resultStep && (resultStep.status === 'DONE' || resultStep.status === 'ERROR')) {
          stepToolMessages.push({
            id: `${sessionId}:${resultStep.step_index}`,
            role: 'tool',
            text: output || (resultStep.status === 'ERROR' ? 'Tool failed.' : 'Tool completed.'),
            toolName,
            failed: resultStep.status === 'ERROR',
          });
          if (toolName === 'ask_question' && resultStep.status === 'DONE' && cleanedResultContent) {
            const parsedAnswers: Array<{ index: string; value: string }> = [];
            for (const rawLine of cleanedResultContent.replace(/\r/g, '').split('\n')) {
              const line = rawLine.trim();
              if (!line) continue;
              const match = /^A(\d+):\s*(.+)$/.exec(line);
              if (match && match[2].trim()) {
                parsedAnswers.push({ index: match[1], value: match[2].trim() });
              } else if (parsedAnswers.length > 0 && !/^(?:Q\d+:|Created At:|Completed At:)/i.test(line)) {
                parsedAnswers[parsedAnswers.length - 1].value += `\n${line}`;
              }
            }
            if (parsedAnswers.length > 0) {
              const formattedAnswers = parsedAnswers.length === 1
                ? parsedAnswers[0].value
                : parsedAnswers.map(entry => `A${entry.index}: ${entry.value}`).join('\n');
              stepToolMessages.push({
                id: `${sessionId}:${resultStep.step_index}:answer`,
                role: 'user',
                text: formattedAnswers,
              });
            }
          }
        } else if (question) {
          stepPendingQuestions.push(question);
        }
      });

      unresolvedQuestions.clear();
      if (stepPendingQuestions.length > 0) {
        unresolvedQuestions.set(stepIndex, stepPendingQuestions);
      }

      if (text.trim() || thinking || tools.length > 0) {
        messages.push({
          id: `${sessionId}:${stepIndex}`,
          role: 'assistant',
          text,
          ...(thinking ? { thinking } : {}),
          ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
          ...(tools.length > 0 ? { tools } : {}),
          ...(model ? { model } : {}),
        });
      }
      messages.push(...stepToolMessages);
    }
  }

  return {
    messages,
    questions: [...unresolvedQuestions.values()].flat(),
    steps,
    sortedSteps,
    completedSubagents,
    hasRunningSubagent,
  };
}

export function parseAntigravityTranscript(source: string, sessionId: string): ManualMessage[] {
  return parseTranscriptInternal(source, sessionId).messages;
}

function stepTimestamp(step: any): string | undefined {
  if (!step || typeof step !== 'object') return undefined;
  for (const key of ['updated_at', 'created_at', 'timestamp', 'at']) {
    const value = step[key];
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  }
  return undefined;
}

function parseLogActivity(logText: string, fallbackAt?: string): {
  pendingQuestionSteps: Set<string>;
  readyForInput: boolean;
  latestAt?: string;
} {
  const pendingQuestionSteps = new Set<string>();
  let readyForInput = false;
  let latestAt = fallbackAt;

  for (const line of logText.split(/\r?\n/)) {
    const tsMatch = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/.exec(line);
    if (tsMatch && Number.isFinite(Date.parse(tsMatch[1]))) latestAt = tsMatch[1];

    const surfaceMatch = /Surfacing ask_question at step (\d+)/i.exec(line);
    if (surfaceMatch) pendingQuestionSteps.add(surfaceMatch[1]);

    const responseMatch = /AskQuestion response\b.*\bstep (\d+)/i.exec(line);
    if (responseMatch) pendingQuestionSteps.delete(responseMatch[1]);

    if (/CLI ready for user input/i.test(line)) readyForInput = true;
  }

  return { pendingQuestionSteps, readyForInput, latestAt };
}

/** Bind only through the log assigned to this specific CLI launch. Never use
 * the shared cli.log, last_conversations.json, cwd matching or the newest file. */
export class ManualAntigravityBridge {
  constructor(private dataDir: string, private transcriptRoot = path.join(os.homedir(),'.gemini','antigravity-cli')) {}
  private directory(agent: ManualAgent) {
    if (!UUID.test(agent.id)) throw new Error('Invalid manual agent identity.');
    return path.join(this.dataDir,'manual-sessions',agent.id);
  }
  private binding(agent: ManualAgent): Binding | undefined {
    try {
      const file = path.join(this.directory(agent),'antigravity-binding.json');
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return;
      const record = JSON.parse(fs.readFileSync(file,'utf8')) as Binding;
      if (!UUID.test(record.launchId) || (record.sessionId && !UUID.test(record.sessionId))) return;
      return record;
    } catch { return; }
  }
  private session(agent: ManualAgent): string | undefined {
    const binding = this.binding(agent); if (!binding) return;
    const log = path.join(this.directory(agent),`antigravity-${binding.launchId}.log`);
    let text: string;
    try {
      const stat = fs.lstatSync(log);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      text = readTail(log,128*1024).source;
    } catch { return; }
    const ids = new Set([...text.matchAll(/\bCreated conversation ([a-f0-9-]{36})\b/gi)].map(match=>match[1].toLowerCase()).filter(id=>UUID.test(id)));
    if (ids.size > 1) return; // Ambiguous log: never guess a root or subagent.
    const discovered = [...ids][0];
    if (discovered && binding.sessionId && discovered !== binding.sessionId.toLowerCase()) return;
    const sessionId = discovered || binding.sessionId;
    if (discovered && !binding.sessionId) {
      // Keep the exact binding after bounded logs rotate beyond the creation event.
      this.writeBinding(agent,{...binding,sessionId});
    }
    return sessionId;
  }
  boundSessionId(agent: ManualAgent): string | undefined {
    return this.session(agent);
  }
  private resolveTranscriptFile(sessionId: string): string | undefined {
    let root: string;
    try {
      root = fs.realpathSync(this.transcriptRoot);
    } catch { return undefined; }
    const candidates = [
      path.join('brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl'),
      path.join('brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl'),
    ];
    for (const relative of candidates) {
      const candidate = path.join(this.transcriptRoot, relative);
      try {
        fs.lstatSync(candidate);
      } catch {
        continue;
      }
      try {
        if (path.relative(root, fs.realpathSync(candidate)).toLowerCase() !== relative.toLowerCase()) return undefined;
        return candidate;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  private writeBinding(agent: ManualAgent, binding: Binding) {
    const filename = path.join(this.directory(agent),'antigravity-binding.json');
    const temporary = `${filename}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(binding),{mode:0o600,flag:'wx'});
    try {
      fs.renameSync(temporary,filename);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      const existing = this.binding(agent);
      if (existing && existing.launchId === binding.launchId && existing.sessionId === binding.sessionId) return;
      throw error;
    }
  }
  prepare(agent: ManualAgent): string[] {
    const sessionId = this.session(agent);
    fs.mkdirSync(this.directory(agent),{recursive:true,mode:0o700});
    const launchId = randomUUID();
    const logFile = path.join(this.directory(agent),`antigravity-${launchId}.log`);
    fs.writeFileSync(logFile,'',{flag:'wx',mode:0o600});
    this.writeBinding(agent,{launchId,sessionId});
    return ['--log-file',logFile,...(sessionId ? ['--conversation',sessionId] : [])];
  }
  read(agent: ManualAgent): { messages: ManualMessage[]; questions: ManualQuestion[]; truncated: boolean; bound: boolean } {
    const empty = {messages:[] as ManualMessage[], questions:[] as ManualQuestion[], truncated:false, bound:false};
    const sessionId = this.session(agent); if (!sessionId) return empty;
    const filename = this.resolveTranscriptFile(sessionId);
    if (!filename) return empty;
    const { parsed, truncated } = readParsedTranscript(filename, sessionId);
    return {messages:parsed.messages, questions:parsed.questions, truncated, bound:true};
  }
  usageSummary(agent: ManualAgent): {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
    turnCount: number;
    durationMs: number;
    usageAvailable: boolean;
    lastRecordedAt: string | null;
  } {
    const empty = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      turnCount: 0,
      durationMs: 0,
      usageAvailable: false,
      lastRecordedAt: null as string | null,
    };
    const sessionId = this.session(agent);
    if (!sessionId) return empty;
    const filename = this.resolveTranscriptFile(sessionId);
    if (!filename) return empty;
    const { parsed, mtimeIso } = readParsedTranscript(filename, sessionId);
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let reasoningTokens = 0;
    let turnCount = 0;
    let minTs: number | null = null;
    let maxTs: number | null = null;

    const nonNeg = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;

    for (const [, step] of parsed.sortedSteps) {
      const tsStr = stepTimestamp(step);
      const ts = tsStr ? Date.parse(tsStr) : NaN;
      if (Number.isFinite(ts)) {
        minTs = minTs === null ? ts : Math.min(minTs, ts);
        maxTs = maxTs === null ? ts : Math.max(maxTs, ts);
      }
      if (step.type !== 'PLANNER_RESPONSE' || step.source !== 'MODEL') continue;
      turnCount += 1;
      const input = nonNeg(step.input_tokens);
      const output = nonNeg(step.output_tokens);
      const cached = nonNeg(step.cache_read_tokens);
      const thinking = nonNeg(step.thinking_tokens);
      inputTokens += input;
      cachedTokens += cached;
      if (step.thinking_tokens !== undefined) {
        reasoningTokens += thinking;
        outputTokens += output;
      } else if (
        step.input_tokens === undefined
        && step.cache_read_tokens === undefined
        && typeof step.thinking === 'string'
        && step.thinking.trim()
      ) {
        // Legacy transcript format where output_tokens held thinking tokens.
        reasoningTokens += output;
      } else {
        outputTokens += output;
      }
    }

    const usageAvailable = inputTokens > 0 || outputTokens > 0 || cachedTokens > 0 || reasoningTokens > 0;
    const durationMs = minTs !== null && maxTs !== null ? Math.max(0, maxTs - minTs) : 0;
    const lastRecordedAt = maxTs !== null
      ? new Date(maxTs).toISOString()
      : this.activity(agent).at || mtimeIso || null;

    return {
      inputTokens,
      outputTokens,
      cachedTokens,
      reasoningTokens,
      turnCount,
      durationMs,
      usageAvailable,
      lastRecordedAt,
    };
  }
  pendingQuestions(agent: ManualAgent): ManualQuestion[] {
    return this.read(agent).questions;
  }
  recentFileTouches(agent: ManualAgent, sinceMs: number): Array<{ path: string; kind: 'read' | 'write'; at: number }> {
    const sessionId = this.session(agent);
    if (!sessionId) return [];
    const filename = this.resolveTranscriptFile(sessionId);
    if (!filename) return [];
    let parsed: ReturnType<typeof readParsedTranscript>['parsed'];
    let fallbackMs: number;
    try {
      const result = readParsedTranscript(filename, sessionId);
      parsed = result.parsed;
      fallbackMs = (result.mtimeIso ? Date.parse(result.mtimeIso) : NaN) || Date.now();
    } catch {
      return [];
    }
    const writeTools = new Set(['edit_file', 'write_file', 'replace_file_content', 'multi_replace_file_content', 'write_to_file', 'delete_file']);
    const touches: Array<{ path: string; kind: 'read' | 'write'; at: number }> = [];
    for (const [, step] of parsed.sortedSteps) {
      if (step.type !== 'PLANNER_RESPONSE' || !Array.isArray(step.tool_calls)) continue;
      const tsStr = stepTimestamp(step);
      const at = tsStr ? Date.parse(tsStr) : fallbackMs;
      if (Number.isFinite(at) && at < sinceMs) continue;
      for (const call of step.tool_calls) {
        const name = String(call?.name || '');
        const kind = writeTools.has(name) ? 'write' : name === 'read_file' ? 'read' : undefined;
        if (!kind) continue;
        const args = unwrapAntigravityArgsRecord(call?.args && typeof call.args === 'object' ? call.args : {});
        for (const key of ['Path', 'path', 'TargetFile', 'file_path']) {
          const candidate = args[key];
          if (typeof candidate === 'string' && candidate.trim()) {
            touches.push({ path: candidate.trim(), kind, at: Number.isFinite(at) ? at : fallbackMs });
          }
        }
      }
    }
    return touches;
  }
  activity(agent: ManualAgent): { state: string; at?: string } {
    const sessionId = this.session(agent);
    if (!sessionId) return { state: 'unknown' };
    const binding = this.binding(agent);
    let logText = '';
    let logMtime: string | undefined;
    if (binding) {
      const log = path.join(this.directory(agent), `antigravity-${binding.launchId}.log`);
      try {
        const stat = fs.lstatSync(log);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          logMtime = stat.mtime.toISOString();
          logText = readTail(log, 128 * 1024).source;
        }
      } catch {}
    }
    const logInfo = parseLogActivity(logText, logMtime);
    const filename = this.resolveTranscriptFile(sessionId);
    if (!filename) {
      if (logInfo.pendingQuestionSteps.size > 0) return { state: 'attention', at: logInfo.latestAt };
      if (logInfo.readyForInput) return { state: 'ready', at: logInfo.latestAt };
      return { state: 'unknown' };
    }

    const { parsed, mtimeIso: fileMtime } = readParsedTranscript(filename, sessionId);
    const latestStep = parsed.sortedSteps.at(-1)?.[1];
    const at = stepTimestamp(latestStep) || fileMtime || logInfo.latestAt;

    if (parsed.questions.length > 0) {
      return { state: 'attention', at };
    }
    const maxStepIndex = parsed.sortedSteps.at(-1)?.[0] ?? -1;
    const unresolvedLogQuestions = [...logInfo.pendingQuestionSteps].filter((rawStep) => {
      const idx = Number(rawStep);
      if (!Number.isInteger(idx)) return false;
      if (maxStepIndex >= idx) {
        const laterStep = parsed.steps.get(idx + 1);
        const currentStep = parsed.steps.get(idx);
        if (currentStep?.type === 'GENERIC' && (currentStep.status === 'DONE' || currentStep.status === 'ERROR')) return false;
        if (laterStep?.type === 'GENERIC' && (laterStep.status === 'DONE' || laterStep.status === 'ERROR')) return false;
        if (parsed.sortedSteps.some(([sIdx, s]) => sIdx > idx && ((s.type === 'USER_INPUT' && s.status === 'DONE') || (s.type === 'PLANNER_RESPONSE' && s.status === 'DONE')))) return false;
      }
      return true;
    });
    if (unresolvedLogQuestions.length > 0) {
      return { state: 'attention', at };
    }

    const hasConversationTurn = parsed.sortedSteps.some(([, step]) =>
      (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT')
      || (step.type === 'PLANNER_RESPONSE' && step.source === 'MODEL'),
    );
    if (!hasConversationTurn) {
      return logInfo.readyForInput ? { state: 'ready', at: logInfo.latestAt || at } : { state: 'unknown' };
    }

    if (parsed.sortedSteps.some(([, step]) => step.status === 'RUNNING' || step.status === 'PENDING' || step.status === 'WAITING')) {
      return { state: 'working', at };
    }
    if (parsed.hasRunningSubagent) {
      return { state: 'working', at };
    }

    if (latestStep?.type === 'PLANNER_RESPONSE' && latestStep.source === 'MODEL' && latestStep.status === 'DONE') {
      const toolCalls = Array.isArray(latestStep.tool_calls) ? latestStep.tool_calls : [];
      if (toolCalls.length === 0) return { state: 'completed', at };
    }

    // Check if the latest turn ended with a completed artifact requesting feedback
    const lastPlannerEntry = [...parsed.sortedSteps].reverse().find(([, step]) => step.type === 'PLANNER_RESPONSE' && step.source === 'MODEL');
    if (lastPlannerEntry && lastPlannerEntry[1].status === 'DONE' && Array.isArray(lastPlannerEntry[1].tool_calls) && lastPlannerEntry[1].tool_calls.length > 0) {
      const [plannerIdx, plannerStep] = lastPlannerEntry;
      const calls = plannerStep.tool_calls as any[];
      const allDone = calls.every((_, callIdx) => {
        const res = parsed.steps.get(plannerIdx + 1 + callIdx);
        return res?.type === 'GENERIC' && (res.status === 'DONE' || res.status === 'ERROR');
      });
      const hasFeedbackArtifact = calls.some((call) => {
        if (call?.name !== 'write_file') return false;
        const args = unwrapAntigravityArgsRecord(call.args && typeof call.args === 'object' ? call.args : {});
        const meta = args.ArtifactMetadata && typeof args.ArtifactMetadata === 'object' ? args.ArtifactMetadata as Record<string, any> : undefined;
        return Boolean(meta?.RequestFeedback);
      });
      if (allDone && hasFeedbackArtifact) {
        return { state: 'completed', at };
      }
    }

    if (latestStep?.status === 'ERROR' || latestStep?.status === 'CANCELLED' || latestStep?.status === 'CANCELED') {
      return { state: 'completed', at };
    }

    return { state: 'working', at };
  }
}
