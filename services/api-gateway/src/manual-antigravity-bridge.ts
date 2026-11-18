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

function basenameAny(filePath: string): string {
  return filePath.includes('\\') ? path.win32.basename(filePath) : path.basename(filePath);
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
    Boolean(entry && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as any).question === 'string' && Array.isArray((entry as any).options)),
  );
  if (validEntries.length === 0) return undefined;

  const questions: ManualQuestion['questions'] = validEntries.map((entry, idx) => {
    const options: Array<{ label: string; description?: string }> = [];
    for (const option of entry.options as unknown[]) {
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
    const conversationId = options.subagentId
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
    summary = args.action ? `Swarm ${String(args.action)}${args.name ? ` (${String(args.name)})` : ''}` : 'Swarm';
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

  for (const line of source.split('\n')) {
    let item: any;
    try { item = JSON.parse(line); } catch { continue; }
    if (!item || typeof item !== 'object' || !Number.isInteger(item.step_index) || item.step_index < 0) continue;
    steps.set(item.step_index, item);
    if (item.type === 'SYSTEM_MESSAGE' && typeof item.content === 'string') {
      for (const match of item.content.matchAll(/\bsender=([a-f0-9-]{36})\b/gi)) {
        completedSubagents.add(match[1].toLowerCase());
      }
    }
  }

  const sortedSteps = [...steps.entries()].sort(([a], [b]) => a - b);
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
        const subagentIdMatch = toolName === 'invoke_subagent'
          ? (typeof args.conversationId === 'string' && UUID.test(args.conversationId) ? args.conversationId : UUID_FINDER.exec(resultContent)?.[1])
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
        } else {
          status = resultStep?.status === 'DONE' ? 'completed' : 'running';
        }

        const output = resultStep && (resultStep.status === 'DONE' || resultStep.status === 'ERROR') && resultContent.trim()
          ? resultContent.trim().slice(0, 4000)
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
          if (toolName === 'ask_question' && resultStep.status === 'DONE' && resultContent) {
            const answerMatches = resultContent
              .replace(/\r/g, '')
              .split('\n')
              .map((line: string) => /^A(\d+):\s*(.+)$/.exec(line.trim()))
              .filter((match: RegExpExecArray | null): match is RegExpExecArray => Boolean(match && match[2].trim()));
            if (answerMatches.length > 0) {
              const formattedAnswers = answerMatches.length === 1
                ? answerMatches[0][2].trim()
                : answerMatches.map((match: RegExpExecArray) => `A${match[1]}: ${match[2].trim()}`).join('\n');
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
    fs.renameSync(temporary,filename);
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
    const tail = readTail(filename);
    const parsed = parseTranscriptInternal(tail.source, sessionId);
    return {messages:parsed.messages, questions:parsed.questions, truncated:tail.truncated, bound:true};
  }
  pendingQuestions(agent: ManualAgent): ManualQuestion[] {
    return this.read(agent).questions;
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

    let fileMtime: string | undefined;
    try { fileMtime = fs.statSync(filename).mtime.toISOString(); } catch {}
    const tail = readTail(filename);
    const parsed = parseTranscriptInternal(tail.source, sessionId);
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

    return { state: 'working', at };
  }
}
