import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { ManualAgent, ManualMessage, ManualQuestion } from './manual-conversations';

const MARKER = '// AtrisAgent managed manual session bridge v1';
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const HOOK_SOURCE = `${MARKER}\n` + String.raw`
'use strict';
const fs = require('node:fs');
let source = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { source += chunk; if (source.length > 1048576) process.exit(1); });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(source);
    const sessionId = input.session_id || input.sessionId;
    const transcriptPath = input.transcript_path || input.transcriptPath;
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(sessionId.replace(/-/g, '_'))) return;
    if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return;
    const event = input.hook_event_name;
    if (!['SessionStart','UserPromptSubmit','Stop','PermissionRequest','PostToolUse'].includes(event)) return;
    const output = process.argv[2];
    if (!output) return;
    const record = {sessionId, transcriptPath, event, at: new Date().toISOString()};
    fs.appendFileSync(output, JSON.stringify(record)+'\n', {mode: 0o600});
  } catch { process.exitCode = 1; }
});
`;

/** OpenCode's plugin is scoped to one launched TUI process. It observes public message parts only. */
const OPENCODE_SOURCE = `${MARKER}\n` + String.raw`
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const AtrisManualSession = async ({client, directory}) => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const output = path.join(root, 'opencode-history.json');
  const pendingFile = path.join(root, 'opencode-questions.json');
  const replyFile = path.join(root, 'opencode-question-reply.json');
  const replyErrorFile = path.join(root, 'opencode-question-error.json');
  const modeFile = path.join(root, 'opencode-auto-mode.json');
  const modeRequestFile = path.join(root, 'opencode-auto-request.json');
  const routeFile = path.join(root, 'opencode-route.json');
  const activityFile = path.join(root, 'opencode-activity.json');
  let autoApprove = false;
  let modeBusy = false;
  const saveMode = (error) => {
    try { fs.writeFileSync(modeFile+'.tmp', JSON.stringify({version:3, enabled:autoApprove, ...(error ? {error} : {})}), {mode:0o600}); fs.renameSync(modeFile+'.tmp', modeFile); } catch {}
  };
  try { fs.rmSync(modeRequestFile, {force:true}); } catch {}
  saveMode();
  const modeTimer = setInterval(async () => {
    if (modeBusy) return;
    let request;
    try { request = JSON.parse(fs.readFileSync(modeRequestFile, 'utf8')); } catch { return; }
    if (typeof request?.enabled !== 'boolean') return;
    modeBusy = true;
    try {
      // The TUI owns Auto mode. Only toggle it when our last confirmed state differs.
      if (autoApprove !== request.enabled) {
        const result = await client.tui.executeCommand({body:{command:'permission.mode'}});
        if (result.error || result.data !== true) throw new Error('OpenCode did not accept the mode change.');
        autoApprove = request.enabled;
      }
      saveMode();
    } catch { saveMode('Could not change OpenCode Auto mode. Retry or use Code.'); }
    finally { try { fs.rmSync(modeRequestFile, {force:true}); } catch {} modeBusy = false; }
  }, 250);
  modeTimer.unref?.();
  const pending = new Map();
  const savePending = () => {
    try { fs.writeFileSync(pendingFile+'.tmp', JSON.stringify([...pending.values()]), {mode: 0o600}); fs.renameSync(pendingFile+'.tmp', pendingFile); } catch {}
  };
  // A previous process's unanswered questions cannot be answered in a new CLI process.
  savePending();
  try { fs.rmSync(replyFile, {force:true}); } catch {}
  try { fs.rmSync(replyErrorFile, {force:true}); } catch {}
  let replyBusy = false;
  const replies = setInterval(async () => {
    if (replyBusy) return;
    let reply;
    try { reply = JSON.parse(fs.readFileSync(replyFile, 'utf8')); } catch { return; }
    if (!reply || !pending.has(reply.id) || pending.get(reply.id).sessionID !== reply.sessionID) return;
    replyBusy = true;
    try {
      // The plugin receives the v1 SDK client, which has no question namespace.
      // Use its configured transport so authentication and directory routing are preserved.
      const result = await client._client.post({url:'/question/{requestID}/reply',path:{requestID:reply.id},query:{directory},body:{answers:reply.answers},headers:{'Content-Type':'application/json'}});
      if (result.error || result.data !== true) throw new Error('OpenCode did not accept the answer.');
      pending.delete(reply.id); savePending(); activity('working'); fs.rmSync(replyFile, {force:true});
    } catch {
      try {
        fs.writeFileSync(replyErrorFile+'.tmp', JSON.stringify({id:reply.id,sessionID:reply.sessionID,error:'OpenCode did not accept the answer. Retry or answer in Code.'}), {mode:0o600});
        fs.renameSync(replyErrorFile+'.tmp', replyErrorFile);
        fs.rmSync(replyFile, {force:true});
      } catch { /* Keep the request for a later attempt if the error cannot be reported. */ }
    } finally { replyBusy = false; }
  }, 250);
  replies.unref?.();
  let saved = {sessionId: null, messages: [], roles: {}};
  try { saved = JSON.parse(fs.readFileSync(output, 'utf8')); } catch {}
  let sessionId = saved.sessionId;
  let activityState = '';
  const activity = (state) => {
    if (!sessionId || state === activityState) return;
    activityState = state;
    try {
      fs.writeFileSync(activityFile+'.tmp', JSON.stringify({sessionId, state, at:new Date().toISOString()}), {mode:0o600});
      fs.renameSync(activityFile+'.tmp', activityFile);
    } catch { /* Activity must never interrupt the CLI. */ }
  };
  activity('ready');
  const messages = new Map((saved.messages || []).map(m => [m.id, m]));
  const roles = new Map(Object.entries(saved.roles || {}));
  let timer;
  const flush = () => {
    while (messages.size > 2000) messages.delete(messages.keys().next().value);
    while (roles.size > 2000) roles.delete(roles.keys().next().value);
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const record = {sessionId, messages: [...messages.values()].slice(-2000), roles: Object.fromEntries([...roles.entries()].slice(-2000))};
        const temp = output+'.tmp';
        fs.writeFileSync(temp, JSON.stringify(record), {mode: 0o600}); fs.renameSync(temp, output);
      } catch { /* A failed UI observer must not terminate the user's CLI. */ }
    }, 80);
  };
  return { "chat.message": async (input, output) => {
    // The hook's input.model may be absent when the TUI uses its current model.
    // The user message's model (including variant) is what OpenCode executes.
    if (sessionId !== input.sessionID) return;
    try {
      const route = JSON.parse(fs.readFileSync(routeFile, 'utf8'));
      const slash = route.model.indexOf('/');
      if (slash < 1 || slash === route.model.length - 1) return;
      output.message.model = {
        providerID:route.model.slice(0,slash), modelID:route.model.slice(slash+1),
        ...(route.reasoning ? {variant:route.reasoning} : {}),
      };
    } catch { /* Preserve the TUI route if the app's live route is unavailable. */ }
  }, "permission.ask": async (input, output) => {
    // The native TUI owns Auto; never change the provider's permission rules here.
    if (input.sessionID === sessionId && output.status === 'ask') activity('attention');
  }, event: async ({event}) => {
    const info = event.properties?.info;
    if (event.type === 'session.created' && info?.id && !info.parentID) { sessionId = info.id; activityState = ''; activity('ready'); flush(); }
    if (event.properties?.sessionID === sessionId) {
      if (event.type === 'session.idle' && !pending.size && activityState === 'working') activity('completed');
      if (event.type === 'session.status' && event.properties?.status?.type === 'busy' && !pending.size) activity('working');
    }
    if (event.type === 'permission.asked' && event.properties?.sessionID === sessionId) activity('attention');
    if (event.type === 'message.updated' && info?.sessionID === sessionId && ['user','assistant'].includes(info.role)) {
      roles.set(info.id, info.role); flush();
    }
    if (event.type === 'question.asked' && event.properties?.sessionID === sessionId && event.properties?.id) {
      const request = event.properties;
      activity('attention');
      pending.set(request.id, {id:request.id, sessionID:sessionId, questions:request.questions}); savePending(); return;
    }
    if (['question.replied','question.rejected'].includes(event.type) && event.properties?.requestID) {
      if (pending.delete(event.properties.requestID)) { savePending(); activity('working'); }
      try {
        const queued = JSON.parse(fs.readFileSync(replyFile, 'utf8'));
        if (queued.id === event.properties.requestID && queued.sessionID === sessionId) fs.rmSync(replyFile, {force:true});
      } catch {}
      try {
        const failed = JSON.parse(fs.readFileSync(replyErrorFile, 'utf8'));
        if (failed.id === event.properties.requestID) fs.rmSync(replyErrorFile, {force:true});
      } catch {}
      return;
    }
    if (event.type !== 'message.part.updated') return;
    const part = event.properties?.part;
    if (!part || part.sessionID !== sessionId || !part.id) return;
    const id = sessionId+':'+part.id;
    const role = roles.get(part.messageID);
    if (part.type === 'text' && role && !part.synthetic && typeof part.text === 'string') {
      messages.set(id, {id, role, text: part.text.slice(0,65536)});
    } else if (part.type === 'tool') {
      messages.set(id, {id, role:'tool', toolName:part.tool || 'Tool', text: 'Tool '+(part.state?.status || 'requested')+'. Open Code for output and approvals.', failed:part.state?.status === 'error'});
    }
    flush();
  }};
};
`;

function writeManaged(filename: string, source: string): void {
  if (fs.existsSync(filename)) {
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('Manual bridge path must not be a symbolic link.');
    const previous = fs.readFileSync(filename, 'utf8');
    if (previous === source) return;
    if (!previous.startsWith(MARKER) && !previous.startsWith('# AtrisAgent managed')) throw new Error('Manual bridge path is occupied by an unmanaged file.');
  }
  fs.writeFileSync(filename, source, {mode: 0o600});
}

export function readTail(filename: string, limit = MAX_HISTORY_BYTES): {source: string; truncated: boolean} {
  const file = fs.openSync(filename, 'r');
  try {
    const size = fs.fstatSync(file).size;
    const length = Math.min(size, limit);
    const bytes = Buffer.alloc(length);
    const count = fs.readSync(file, bytes, 0, length, size - length);
    return {source: bytes.subarray(0, count).toString('utf8'), truncated: size > length};
  } finally { fs.closeSync(file); }
}

function codexIdentity(filename: string, id: string): boolean {
  const file = fs.openSync(filename, 'r');
  try {
    const buffer = Buffer.alloc(65536); const read = fs.readSync(file, buffer, 0, buffer.length, 0);
    const first = JSON.parse(buffer.subarray(0, read).toString('utf8').split('\n')[0]);
    return first.type === 'session_meta' && (first.payload?.id === id || first.payload?.session_id === id);
  } catch { return false; } finally { fs.closeSync(file); }
}

/** Provider transcript formats are versioned defensively; unknown records never become assistant claims. */
export function parseCodexManualTranscript(source: string, sessionId: string): ManualMessage[] {
  const messages: ManualMessage[] = [];
  const seen = new Set<string>();
  for (const line of source.split('\n')) {
    let item: any; try { item = JSON.parse(line); } catch { continue; }
    const payload = item.payload;
    if (!payload) continue;
    const key = `${sessionId}:${payload.type}:${payload.id || payload.call_id || createHash('sha256').update(line).digest('hex').slice(0,24)}`;
    if (seen.has(key)) continue;
    if (item.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
      messages.push({id:key, role:'user', text:payload.message}); seen.add(key); continue;
    }
    if (item.type !== 'response_item') continue;
    if (payload.type === 'message' && payload.role === 'assistant' && payload.channel !== 'analysis') {
      const text = (Array.isArray(payload.content) ? payload.content : []).filter((part: any) => ['input_text','output_text','text'].includes(part.type)).map((part: any) => part.text || '').join('\n');
      if (!text) continue;
      messages.push({ id: key, role: payload.role, text }); seen.add(key);
    } else if (['function_call','custom_tool_call'].includes(payload.type)) {
      let question: ManualQuestion | undefined;
      if (payload.name === 'request_user_input') {
        try {
          const args = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : payload.arguments;
          if (Array.isArray(args?.questions)) question = {id:String(payload.call_id || key), questions:args.questions.filter((entry: any) => typeof entry.question === 'string' && Array.isArray(entry.options)).map((entry: any) => ({header:String(entry.header || ''),question:entry.question,options:entry.options.filter((option: any) => typeof option.label === 'string').map((option: any) => ({label:option.label,description:typeof option.description === 'string' ? option.description : undefined})),custom:true}))};
        } catch { /* Malformed tool input stays in Code. */ }
      }
      messages.push({ id: key, role: 'tool', toolName: payload.name || 'Tool', text: 'Tool requested. Open Code for live output and approvals.', ...(question?.questions.length ? {question} : {}) }); seen.add(key);
    } else if (['function_call_output','custom_tool_call_output'].includes(payload.type)) {
      messages.push({ id: key, role: 'tool', text: 'Tool returned. Open Code to inspect its output.' }); seen.add(key);
    }
  }
  return messages;
}

export class ManualProviderBridge {
  constructor(private dataDir: string) {}
  activity(agent: ManualAgent): { state: string; at?: string } {
    if (agent.runtimeType === 'opencode') {
      try {
        const filename = path.join(this.directory(agent), 'opencode-activity.json');
        if (fs.lstatSync(filename).isSymbolicLink() || fs.statSync(filename).size > 4096) return {state:'unknown'};
        const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (record.sessionId !== this.openCodeHistory(agent).sessionId || !['ready','working','attention','completed'].includes(record.state) || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) return {state:'unknown'};
        return {state:record.state,at:record.at};
      } catch { return {state:'unknown'}; }
    }
    if (!['claude_code', 'codex'].includes(agent.runtimeType)) return { state: 'unknown' };
    const bindings = agent.runtimeType === 'claude_code' ? this.claudeBindings(agent) : this.codexBindings(agent);
    const current = bindings.at(-1);
    if (!current) return { state: 'unknown' };
    const states: Record<string, string> = { SessionStart: 'ready', UserPromptSubmit: 'working', PostToolUse: 'working', PermissionRequest: 'attention', Stop: 'completed' };
    let latest: { state: string; at?: string } = { state: 'unknown' };
    for (const line of readTail(path.join(this.directory(agent), 'bindings.jsonl'), 128 * 1024).source.split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event.sessionId !== current.sessionId || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)) || !states[event.event]) continue;
        if (fs.realpathSync(event.transcriptPath) !== current.transcriptPath) continue;
        if (!latest.at || Date.parse(event.at) >= Date.parse(latest.at)) latest = { state: states[event.event], at: event.at };
      } catch { /* Ignore incomplete and foreign hook records. */ }
    }
    return latest;
  }
  private directory(agent: ManualAgent): string { return path.join(this.dataDir, 'manual-sessions', agent.id); }
  private codexRoot(agent: ManualAgent): string { return agent.sharedProfile ? process.env.CODEX_HOME || path.join(os.homedir(), '.codex') : agent.configDir; }
  private hookCommand(agent: ManualAgent): {command: string; commandWindows: string} {
    const directory = this.directory(agent); fs.mkdirSync(directory, {recursive:true, mode:0o700});
    const script = path.join(directory, 'bind-session.cjs'); writeManaged(script, HOOK_SOURCE);
    const args = [process.execPath, script, path.join(directory, 'bindings.jsonl')];
    const command = args.map(value => "'"+value.replaceAll("'", "'\\''")+"'").join(' ');
    const windowsScript = '& '+args.map(value => "'"+value.replaceAll("'", "''")+"'").join(' ');
    return {command, commandWindows:'powershell.exe -NoLogo -NoProfile -EncodedCommand '+Buffer.from(windowsScript, 'utf16le').toString('base64')};
  }
  claudeBindings(agent: ManualAgent): {sessionId: string; transcriptPath: string}[] {
    const filename = path.join(this.directory(agent), 'bindings.jsonl');
    if (!fs.existsSync(filename)) return [];
    const configuredRoot = agent.sharedProfile ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') : agent.configDir;
    if (!fs.existsSync(path.join(configuredRoot, 'projects'))) return [];
    const root = fs.realpathSync(path.join(configuredRoot, 'projects'));
    const records = new Map<string, {sessionId: string; transcriptPath: string}>();
    for (const line of readTail(filename, 128 * 1024).source.split('\n')) {
      try {
        const binding = JSON.parse(line);
        if (typeof binding.sessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(binding.sessionId) || typeof binding.transcriptPath !== 'string') continue;
        const actual = fs.realpathSync(binding.transcriptPath);
        const relative = path.relative(root, actual);
        if (relative.startsWith('..') || path.isAbsolute(relative) || path.basename(actual) !== `${binding.sessionId}.jsonl` || relative.split(path.sep).includes('subagents')) continue;
        records.delete(binding.sessionId); records.set(binding.sessionId, {sessionId:binding.sessionId, transcriptPath:actual});
      } catch { /* Never guess a history path from a malformed hook. */ }
    }
    return [...records.values()];
  }
  prepareClaude(agent: ManualAgent, hasInitialTranscript: boolean): string[] {
    const command = this.hookCommand(agent);
    const hooks = Object.fromEntries(['SessionStart','UserPromptSubmit','Stop','PermissionRequest','PostToolUse'].map(event => [event, [{hooks:[{type:'command', command:process.platform === 'win32' ? command.commandWindows : command.command, timeout:5}]}]]));
    const bound = this.claudeBindings(agent).at(-1);
    // A file avoids Windows .cmd/PowerShell stripping embedded JSON quotation marks.
    // Content-addressed files are immutable; an existing unmanaged file is never overwritten.
    const settings = JSON.stringify({hooks});
    const settingsFile = path.join(this.directory(agent), `claude-settings-${createHash('sha256').update(settings).digest('hex').slice(0,16)}.json`);
    writeManaged(settingsFile, settings);
    return ['--model', agent.model, ...(bound || hasInitialTranscript ? ['--resume', bound?.sessionId || agent.providerSessionId] : ['--session-id', agent.providerSessionId]), '--settings', settingsFile, ...(agent.reasoning ? ['--effort', agent.reasoning] : [])];
  }
  private codexBindings(agent: ManualAgent): {sessionId: string; transcriptPath: string}[] {
    const filename = path.join(this.directory(agent), 'bindings.jsonl');
    if (!fs.existsSync(filename)) return [];
    const records = new Map<string, {sessionId: string; transcriptPath: string}>();
    const root = fs.realpathSync(this.codexRoot(agent));
    for (const line of readTail(filename, 128 * 1024).source.split('\n')) {
      try {
        const binding = JSON.parse(line);
        if (typeof binding.sessionId !== 'string' || typeof binding.transcriptPath !== 'string' || !binding.transcriptPath.endsWith('.jsonl')) continue;
        const actual = fs.realpathSync(binding.transcriptPath);
        const relative = path.relative(root, actual);
        if (relative.startsWith('..') || path.isAbsolute(relative) || !codexIdentity(actual, binding.sessionId)) continue;
        records.delete(binding.sessionId); records.set(binding.sessionId, {sessionId: binding.sessionId, transcriptPath: actual});
      } catch { /* Partial/invalid/foreign bindings are never attributed. */ }
    }
    return [...records.values()];
  }
  prepareCodex(agent: ManualAgent): string[] {
    const root = this.codexRoot(agent); fs.mkdirSync(root, {recursive:true, mode:0o700});
    const {command, commandWindows} = this.hookCommand(agent);
    const profile = `atris-manual-${agent.id}`;
    // Profile layers add hooks alongside existing hooks; neither user config nor credentials are copied.
    const config = '# AtrisAgent managed manual session bridge v1\n' + ['SessionStart','UserPromptSubmit','Stop','PermissionRequest','PostToolUse'].map(event => `\n[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ncommand_windows = ${JSON.stringify(commandWindows)}\ntimeout = 5\n`).join('');
    writeManaged(path.join(root, `${profile}.config.toml`), config);
    const bound = this.codexBindings(agent).at(-1);
    return [...(bound ? ['resume', bound.sessionId] : []), '--profile', profile, '--model', agent.model, ...(agent.reasoning ? ['-c', `model_reasoning_effort="${agent.reasoning}"`] : [])];
  }
  prepareOpenCode(agent: ManualAgent): {args: string[]; env: Record<string,string>} {
    const directory = this.directory(agent); fs.mkdirSync(directory, {recursive:true, mode:0o700});
    fs.rmSync(path.join(directory, 'opencode-activity.json'), {force:true});
    // A new TUI starts in normal mode. Never display a previous process's mode as active.
    fs.rmSync(path.join(directory, 'opencode-auto-mode.json'), {force:true});
    fs.rmSync(path.join(directory, 'opencode-auto-request.json'), {force:true});
    this.updateOpenCodeRoute(agent);
    const plugin = path.join(directory, `manual-plugin-${createHash('sha256').update(OPENCODE_SOURCE).digest('hex').slice(0,16)}.mjs`); writeManaged(plugin, OPENCODE_SOURCE);
    const history = this.openCodeHistory(agent);
    // Merge inherited configuration inside the native launcher. Never send its possibly-secret contents to the UI.
    return {args: [...(history.sessionId ? ['--session', history.sessionId] : []), '--model', agent.model], env: {ATRIS_MANUAL_OPENCODE_PLUGIN: pathToFileURL(plugin).href}};
  }
  updateOpenCodeRoute(agent: ManualAgent): void {
    if (agent.runtimeType !== 'opencode' || !/^[^/]+\/.+$/.test(agent.model)) throw new Error('Invalid OpenCode model route.');
    const filename = path.join(this.directory(agent), 'opencode-route.json');
    fs.mkdirSync(path.dirname(filename), {recursive:true, mode:0o700});
    for (const target of [filename, filename+'.tmp']) {
      if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Manual route path must not be a symbolic link.');
    }
    fs.writeFileSync(filename+'.tmp', JSON.stringify({model:agent.model, reasoning:agent.reasoning || null}), {mode:0o600});
    fs.renameSync(filename+'.tmp', filename);
  }
  autoApprove(agent: ManualAgent): {available: boolean; enabled: boolean; error?: string} {
    if (agent.runtimeType !== 'opencode') return {available:false, enabled:false};
    try {
      const filename = path.join(this.directory(agent), 'opencode-auto-mode.json');
      if (fs.statSync(filename).size > 4096) return {available:false, enabled:false};
      const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (record.version !== 3 || typeof record.enabled !== 'boolean') return {available:false, enabled:false};
      return {available:true, enabled:record.enabled, ...(typeof record.error === 'string' ? {error:record.error} : {})};
    } catch { return {available:false, enabled:false}; }
  }
  setAutoApprove(agent: ManualAgent, enabled: unknown): void {
    if (agent.runtimeType !== 'opencode' || typeof enabled !== 'boolean') throw Object.assign(new Error('Invalid OpenCode permission mode.'), {status:400});
    if (!this.autoApprove(agent).available) throw Object.assign(new Error('Open this OpenCode agent before changing permissions.'), {status:409});
    const filename = path.join(this.directory(agent), 'opencode-auto-request.json');
    if (fs.existsSync(filename)) throw Object.assign(new Error('Permission mode is already changing.'), {status:409});
    fs.writeFileSync(filename, JSON.stringify({id:randomUUID(),enabled}), {flag:'wx',mode:0o600});
  }
  private openCodeHistory(agent: ManualAgent): {sessionId: string | null; messages: ManualMessage[]} {
    const filename = path.join(this.directory(agent), 'opencode-history.json');
    if (!fs.existsSync(filename)) return {sessionId:null, messages:[]};
    if (fs.statSync(filename).size > 16 * 1024 * 1024) throw new Error('OpenCode history exceeded the supported size. Continue in Code.');
    const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (typeof record.sessionId !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(record.sessionId)) return {sessionId:null,messages:[]};
    return {sessionId: record.sessionId, messages: Array.isArray(record.messages) ? record.messages.filter((m: any) => typeof m.id === 'string' && typeof m.text === 'string' && ['user','assistant','tool'].includes(m.role)) : []};
  }
  pendingQuestions(agent: ManualAgent): Array<{id: string; questions: Array<{header: string; question: string; options: Array<{label: string; description?: string}>; multiple?: boolean; custom?: boolean}>; deliveryError?: string}> {
    if (agent.runtimeType !== 'opencode') return [];
    const sessionId = this.openCodeHistory(agent).sessionId;
    if (!sessionId) return [];
    const filename = path.join(this.directory(agent), 'opencode-questions.json');
    try {
      if (fs.statSync(filename).size > 65536) return [];
      const records = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!Array.isArray(records)) return [];
      let failure: any;
      try {
        const errorFile = path.join(this.directory(agent), 'opencode-question-error.json');
        if (fs.statSync(errorFile).size < 4096) failure = JSON.parse(fs.readFileSync(errorFile, 'utf8'));
      } catch {}
      return records.filter((record: any) => record.sessionID === sessionId && typeof record.id === 'string' && Array.isArray(record.questions))
        .map((record: any) => ({id:record.id, questions:record.questions.filter((question: any) => typeof question.question === 'string' && Array.isArray(question.options)).map((question: any) => ({header:String(question.header || ''), question:question.question, options:question.options.filter((option: any) => typeof option.label === 'string').map((option: any) => ({label:option.label, description:typeof option.description === 'string' ? option.description : undefined})), multiple:Boolean(question.multiple), custom:question.custom !== false})), ...(failure?.id === record.id && failure.sessionID === sessionId && typeof failure.error === 'string' ? {deliveryError:failure.error} : {})}));
    } catch { return []; }
  }
  replyQuestion(agent: ManualAgent, id: string, answers: string[][]): void {
    if (agent.runtimeType !== 'opencode') throw Object.assign(new Error('Answer this provider in Code.'), {status:400});
    const question = this.pendingQuestions(agent).find(record => record.id === id);
    if (!question) throw Object.assign(new Error('This question is no longer pending.'), {status:409});
    if (!Array.isArray(answers) || answers.length !== question.questions.length || answers.some((answer, index) => !Array.isArray(answer) || !answer.length || (!question.questions[index].multiple && answer.length !== 1) || answer.some(value => typeof value !== 'string' || !value.trim() || value.length > 2000 || (!question.questions[index].custom && !question.questions[index].options.some(option => option.label === value))))) throw Object.assign(new Error('Select an answer for each question.'), {status:400});
    const filename = path.join(this.directory(agent), 'opencode-question-reply.json');
    if (fs.existsSync(filename)) throw Object.assign(new Error('An answer is already being delivered.'), {status:409});
    fs.rmSync(path.join(this.directory(agent), 'opencode-question-error.json'), {force:true});
    fs.writeFileSync(filename, JSON.stringify({id, sessionID:this.openCodeHistory(agent).sessionId, answers}), {flag:'wx', mode:0o600});
  }
  read(agent: ManualAgent): {messages: ManualMessage[]; truncated: boolean; bound: boolean} {
    if (agent.runtimeType === 'opencode') {
      const history = this.openCodeHistory(agent); return {messages:history.messages, truncated:history.messages.length >= 2000, bound:Boolean(history.sessionId)};
    }
    const bindings = this.codexBindings(agent);
    let truncated = bindings.length > 8;
    const messages = bindings.slice(-8).flatMap(binding => { const tail = readTail(binding.transcriptPath); truncated ||= tail.truncated; return parseCodexManualTranscript(tail.source, binding.sessionId); });
    return {messages, truncated, bound:bindings.length > 0};
  }
}
