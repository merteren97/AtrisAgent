import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readTail } from './manual-provider-bridge';
import type { ManualAgent, ManualMessage } from './manual-conversations';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
interface Binding { launchId: string; sessionId?: string }

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

export function parseAntigravityTranscript(source: string, sessionId: string): ManualMessage[] {
  const messages = new Map<string, ManualMessage>();
  for (const line of source.split('\n')) {
    let item: any; try { item = JSON.parse(line); } catch { continue; }
    if (!Number.isInteger(item.step_index) || item.step_index < 0 || item.status !== 'DONE' || typeof item.content !== 'string' || !item.content.trim()) continue;
    // Checkpoint/system/thinking/tool payloads are not public assistant replies.
    const role = item.type === 'USER_INPUT' && item.source === 'USER_EXPLICIT' ? 'user'
      : item.type === 'PLANNER_RESPONSE' && item.source === 'MODEL' ? 'assistant' : null;
    if (!role) continue;
    const id = `${sessionId}:${item.step_index}`;
    const text = role === 'user' ? userRequestText(item.content) : item.content;
    if (!text.trim()) { messages.delete(id); continue; }
    messages.set(id,{id,role,text});
  }
  return [...messages.values()];
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
  read(agent: ManualAgent) {
    const empty = {messages:[] as ManualMessage[],truncated:false,bound:false};
    const sessionId = this.session(agent); if (!sessionId) return empty;
    const relative = path.join('brain',sessionId,'.system_generated','logs','transcript.jsonl');
    const filename = path.join(this.transcriptRoot,relative);
    try {
      const root = fs.realpathSync(this.transcriptRoot);
      if (path.relative(root,fs.realpathSync(filename)).toLowerCase() !== relative.toLowerCase()) return empty;
    } catch { return empty; }
    const tail = readTail(filename);
    return {messages:parseAntigravityTranscript(tail.source,sessionId),truncated:tail.truncated,bound:true};
  }
}
