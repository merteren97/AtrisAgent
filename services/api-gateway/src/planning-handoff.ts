import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Application } from 'express';
import type { RuntimeHost } from '@atris-agent-code/runtime-host';
import type { ManualAgent, ManualConversation, ManualConversationStore } from './manual-conversations';
import { PlanningError, type PlanningStore } from './planning-store';

const BASE = '/api/workspaces/:workspaceId/plans/:planId/handoff';
const MAX_OPTIONS_BYTES = 32_000;
const MAX_PROMPT_BYTES = 96_000;
type Execution = ReturnType<PlanningStore['getExecution']>;
export interface PlanningHandoffInput {
  id: string;
  target: 'manual' | 'orchestrator';
  catalogId?: string;
  reasoning?: string;
  options?: Record<string, unknown>;
}
export interface PlanningHandoffSource {
  workspaceId: string; planId: string; executionId: string; href: string;
  snapshotPath: string;
}
export interface PlanningOrchestratorStart {
  workspaceId: string;
  request: string;
  options: Record<string, unknown>;
  /** The callback must pass this through to its durable mission-start idempotency mechanism. */
  idempotencyKey: string;
}
export interface PlanningHandoffOptions {
  store: PlanningStore;
  manualStore: ManualConversationStore;
  runtimeHost: Pick<RuntimeHost, 'getModelCatalogService' | 'getAccountProfileManager'>;
  sqlite: Database.Database;
  /** Wrap the normal mission-start policy/team/routing normalization, then createQueuedMissionStart. */
  startOrchestrator(input: PlanningOrchestratorStart): Promise<{ missionId: string; [key: string]: unknown }>;
  fenced?: (workspaceId: string) => boolean;
}
interface Prepared {
  prompt: string;
  source: PlanningHandoffSource;
  title: string;
  agent?: ManualAgent;
  options: Record<string, unknown>;
  idempotencyKey: string;
}
interface TargetResult {
  conversation?: ManualConversation;
  agent?: ManualAgent;
  missionId?: string;
  orchestrator?: { missionId: string; [key: string]: unknown };
}
interface Receipt { payload: string; prepared: string; result: string | null; target_id: string | null }

function fail(message: string, status = 400, code = 'INVALID_HANDOFF_REQUEST'): never {
  throw new PlanningError(message, status, code);
}
function conflict(): never { return fail('This handoff ID is already bound to different input.', 409, 'HANDOFF_CONFLICT'); }
function optionalText(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) fail(`Invalid ${field}.`);
  return value;
}
/** Canonical JSON also makes option key order irrelevant to idempotency. */
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 12) fail('Options are nested too deeply.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Options must contain JSON values.');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Invalid option key.');
    result[key] = canonical((value as Record<string, unknown>)[key], depth + 1);
  }
  return result;
}
function inputPayload(value: PlanningHandoffInput): { input: PlanningHandoffInput; payload: string } {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.id)) fail('A UUID handoff id is required.');
  if (!['manual', 'orchestrator'].includes(value.target)) fail('Select Manual or Orchestrator.');
  const catalogId = optionalText(value.catalogId, 'catalogId', 512);
  const reasoning = optionalText(value.reasoning, 'reasoning', 32);
  if (value.target === 'manual' && !catalogId) fail('Select a model for Manual.');
  if (value.options !== undefined && (!value.options || typeof value.options !== 'object' || Array.isArray(value.options))) fail('options must be a JSON object.');
  const options = canonical(value.options ?? {}) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(options)) > MAX_OPTIONS_BYTES) fail('Handoff options exceed the size limit.', 413);
  if (catalogId && options.modelCatalogId !== undefined && options.modelCatalogId !== catalogId) fail('Conflicting model selections.');
  if (reasoning && options.reasoningLevel !== undefined && options.reasoningLevel !== reasoning) fail('Conflicting reasoning selections.');
  const input = { id: value.id.toLowerCase(), target: value.target, catalogId, reasoning, options };
  return { input, payload: JSON.stringify(canonical(inputForJson(input))) };
}
function inputForJson(input: PlanningHandoffInput) {
  return { target: input.target, catalogId: input.catalogId ?? null, reasoning: input.reasoning ?? null, options: input.options };
}
function stableUuid(scope: string, label: string): string {
  const bytes = createHash('sha256').update(`atris-planning-handoff:${label}:${scope}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function sourceFor(execution: Execution): PlanningHandoffSource {
  const { workspaceId, planId, id: executionId, snapshotPath } = execution;
  return { workspaceId, planId, executionId, snapshotPath,
    href: `/api/workspaces/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planId)}/executions/${encodeURIComponent(executionId)}` };
}
function buildPrompt(execution: Execution, source: PlanningHandoffSource): string {
  const lines = [
    'Execute the implementation plan from this immutable planning snapshot. Follow its requirements and validation criteria; report progress and evidence honestly.',
    'The handoff only prepares/queues execution; it is not evidence that the work is complete.',
    `Planning source: ${source.href}`,
    `Source IDs: ${JSON.stringify({ workspaceId: source.workspaceId, planId: source.planId, executionId: source.executionId })}`,
    `Read-only snapshot directory (absolute, accessible from isolated worktrees): ${JSON.stringify(execution.snapshotPath)}`,
    `Complete file manifest with SHA-256 hashes: ${JSON.stringify(path.join(execution.snapshotPath, 'request.json'))}`,
    ...(execution.boardRevision ? [`Board revision: ${execution.boardRevision}. Read board/board.json and its referenced Markdown bodies from the snapshot.`] : []),
    'Use only these snapshot inputs, not the mutable original plan/research/assets. Do not edit the snapshot. Read omitted/truncated contents from their absolute paths as needed.',
    '\n## Snapshot files (absolute paths)',
  ];
  let pathBudget = 16_000;
  for (const file of execution.files) {
    const line = `${JSON.stringify(path.join(execution.snapshotPath, file.path))} (${file.byteSize} bytes; sha256 ${file.sha256})`;
    if (Buffer.byteLength(line) > pathBudget) { lines.push('Additional files are listed in the complete snapshot manifest.'); break; }
    lines.push(line); pathBudget -= Buffer.byteLength(line) + 1;
  }
  lines.push('\n## Snapshot Markdown contents');
  let remaining = 48_000;
  const markdown = execution.files.filter(file => file.path === 'plan.md' || /^research\/.*\.md$/i.test(file.path) || /^board\/content\/.*\.md$/i.test(file.path));
  markdown.sort((a, b) => Number(b.path === 'plan.md') - Number(a.path === 'plan.md') || a.path.localeCompare(b.path));
  for (const file of markdown) {
    if (remaining <= 0) break;
    const maximum = Math.min(file.byteSize, remaining, file.path === 'plan.md' ? 32_000 : 8_000);
    const absolutePath = path.join(execution.snapshotPath, file.path);
    const fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const bytes = Buffer.alloc(maximum);
    let count = 0;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.byteSize) fail('Snapshot changed during handoff.', 409, 'EXECUTION_CHANGED');
      while (count < maximum) {
        const read = fs.readSync(fd, bytes, count, maximum - count, null);
        if (!read) break;
        count += read;
      }
    } finally { fs.closeSync(fd); }
    const heading = `\n### ${JSON.stringify(file.path)} — ${JSON.stringify(absolutePath)}\n`;
    const content = bytes.subarray(0, count).toString('utf8');
    lines.push(heading, content, ...(count < file.byteSize ? ['[Preview truncated; read the full snapshot file above.]'] : []));
    remaining -= Buffer.byteLength(heading) + Buffer.byteLength(content) + 80;
  }
  const prompt = lines.join('\n');
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) fail('Snapshot context exceeds the handoff request limit.', 413);
  return prompt;
}

async function manualAgent(options: PlanningHandoffOptions, input: PlanningHandoffInput, scope: string, cwd: string): Promise<ManualAgent> {
  const descriptor = await options.runtimeHost.getModelCatalogService().resolveModelDescriptor(input.catalogId!);
  if (!descriptor || descriptor.catalogId !== input.catalogId || descriptor.availability !== 'available' || descriptor.source === 'cached' || !descriptor.runtimeModelId) fail('Select a verified, available model from Accounts.');
  const profile = await options.runtimeHost.getAccountProfileManager().getProfileById(descriptor.accountProfileId);
  if (!profile || profile.authStatus !== 'connected') fail('The selected CLI account is not connected.');
  if (profile.runtimeType !== descriptor.runtimeId || !['claude_code', 'codex', 'opencode', 'antigravity'].includes(profile.runtimeType)) fail('This model does not expose a supported interactive CLI.', 422);
  const reasoning = input.reasoning ?? descriptor.defaultReasoning ?? descriptor.supportedReasoning?.[0];
  if (reasoning && !descriptor.supportedReasoning?.includes(reasoning as never)) fail('This model does not support the selected reasoning level.');
  return { id: stableUuid(scope, 'agent'), conversationId: stableUuid(scope, 'conversation'),
    providerSessionId: stableUuid(scope, 'provider-session'), name: 'Plan execution',
    catalogId: descriptor.catalogId, runtimeType: profile.runtimeType, model: descriptor.runtimeModelId,
    accountProfileId: profile.id, configDir: profile.configDir, sharedProfile: profile.profileMode === 'shared_cli',
    cwd, createdAt: new Date().toISOString(), ...(reasoning ? { reasoning } : {}) };
}

/** Query a durable target backlink after installation, including recovery before the file receipt is linked. */
export function findPlanningHandoffSource(sqlite: Database.Database, target: PlanningHandoffInput['target'], targetId: string): PlanningHandoffSource | null {
  const row = sqlite.prepare('SELECT prepared FROM planning_handoff_receipts WHERE target = ? AND target_id = ?').get(target, targetId) as { prepared: string } | undefined;
  return row ? (JSON.parse(row.prepared) as Prepared).source : null;
}

/** Mount AFTER runtime-token + Hub identity/entitlement middleware, never as a local-data bypass. */
export function installPlanningHandoffRoutes(app: Application, options: PlanningHandoffOptions): void {
  const { sqlite, store } = options;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS planning_handoff_receipts (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL, operation_id TEXT NOT NULL, target TEXT NOT NULL,
    payload TEXT NOT NULL, prepared TEXT NOT NULL, result TEXT, target_id TEXT,
    PRIMARY KEY (workspace_id, plan_id, operation_id));
    CREATE INDEX IF NOT EXISTS planning_handoff_target ON planning_handoff_receipts(target, target_id);`);
  const locks = new Map<string, Promise<unknown>>();
  const checkFence = (workspaceId: string) => {
    if (options.fenced?.(workspaceId)) fail('Workspace deletion is in progress.', 409, 'DELETION_IN_PROGRESS');
  };
  const readReceipt = (w: string, p: string, id: string) => sqlite.prepare('SELECT payload, prepared, result, target_id FROM planning_handoff_receipts WHERE workspace_id = ? AND plan_id = ? AND operation_id = ?').get(w, p, id) as Receipt | undefined;

  async function handoff(w: string, p: string, input: PlanningHandoffInput, payload: string) {
    checkFence(w);
    let receipt = readReceipt(w, p, input.id);
    if (receipt && receipt.payload !== payload) conflict();
    const duplicate = Boolean(receipt?.result);
    if (!receipt) {
      const workspace = store.workspace(w);
      const plan = store.get(w, p);
      const scope = JSON.stringify([w, p, input.id]);
      const agent = input.target === 'manual' ? await manualAgent(options, input, scope, fs.realpathSync(workspace.path)) : undefined;
      checkFence(w);
      // Reuse an existing snapshot WITHOUT comparing its selection with the live file list.
      let execution: Execution;
      try { execution = store.getExecution(w, p, input.id); }
      catch (error) {
        if (!(error instanceof PlanningError) || error.code !== 'EXECUTION_NOT_FOUND') throw error;
        execution = store.createExecution(w, p, { id: input.id, target: input.target, paths: store.listFiles(w, p).map(file => file.path) });
      }
      if (execution.target !== input.target || execution.targetId) conflict();
      const source = sourceFor(execution);
      const prepared: Prepared = { prompt: buildPrompt(execution, source), source, title: plan.title,
        ...(agent ? { agent } : {}), options: { ...input.options,
          ...(input.catalogId ? { modelCatalogId: input.catalogId } : {}),
          ...(input.reasoning ? { reasoningLevel: input.reasoning } : {}) },
        idempotencyKey: `planning-handoff:${createHash('sha256').update(scope).digest('hex')}` };
      sqlite.prepare('INSERT OR IGNORE INTO planning_handoff_receipts (workspace_id, plan_id, operation_id, target, payload, prepared) VALUES (?, ?, ?, ?, ?, ?)')
        .run(w, p, input.id, input.target, payload, JSON.stringify(prepared));
      receipt = readReceipt(w, p, input.id)!;
      if (receipt.payload !== payload) conflict();
    }
    const prepared = JSON.parse(receipt.prepared) as Prepared;
    const snapshot = store.getExecution(w, p, input.id);
    if (snapshot.target !== input.target || snapshot.snapshotPath !== prepared.source.snapshotPath
      || (snapshot.targetId && snapshot.targetId !== receipt.target_id)) conflict();
    let result = receipt.result ? JSON.parse(receipt.result) as TargetResult : undefined;
    if (!result) {
      checkFence(w);
      if (input.target === 'manual') {
        // No launch/discovery/provider calls. Native launch and prompt seeding belong to the desktop.
        result = sqlite.transaction(() => {
          const conversation = options.manualStore.create(w, prepared.title, prepared.agent!.conversationId);
          const [agent] = options.manualStore.saveBatch([prepared.agent!]);
          if (agent.catalogId !== prepared.agent!.catalogId || agent.model !== prepared.agent!.model || agent.accountProfileId !== prepared.agent!.accountProfileId
            || agent.cwd !== prepared.agent!.cwd || agent.reasoning !== prepared.agent!.reasoning || agent.runtimeType !== prepared.agent!.runtimeType
            || agent.configDir !== prepared.agent!.configDir || agent.sharedProfile !== prepared.agent!.sharedProfile
            || agent.providerSessionId !== prepared.agent!.providerSessionId) conflict();
          return { conversation: { ...conversation, agents: [agent] }, agent };
        })();
      } else {
        const orchestrator = await options.startOrchestrator({ workspaceId: w, request: prepared.prompt,
          options: JSON.parse(JSON.stringify(prepared.options)), idempotencyKey: prepared.idempotencyKey });
        if (!orchestrator || typeof orchestrator.missionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(orchestrator.missionId)) fail('Mission start did not return a valid missionId.', 502, 'INVALID_HANDOFF_TARGET');
        result = { missionId: orchestrator.missionId, orchestrator };
      }
      const serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized) > 256_000) fail('Handoff target receipt exceeds the size limit.', 502);
      sqlite.prepare('UPDATE planning_handoff_receipts SET result = ?, target_id = ? WHERE workspace_id = ? AND plan_id = ? AND operation_id = ? AND result IS NULL')
        .run(serialized, result.agent?.conversationId ?? result.missionId, w, p, input.id);
      receipt = readReceipt(w, p, input.id)!;
      result = JSON.parse(receipt.result!) as TargetResult;
    }
    checkFence(w);
    const execution = store.recordExecutionTarget(w, p, input.id, receipt.target_id!);
    return { id: input.id, target: input.target, status: input.target === 'manual' ? 'ready' : 'queued',
      duplicate, execution, source: prepared.source, prompt: prepared.prompt, ...result };
  }

  app.post(BASE, (req, res) => {
    void (async () => {
      const { input, payload } = inputPayload(req.body);
      const workspaceId = String(req.params.workspaceId);
      const planId = String(req.params.planId);
      const key = JSON.stringify([workspaceId, planId, input.id]);
      const previous = locks.get(key) ?? Promise.resolve();
      const operation = previous.catch(() => undefined).then(() => handoff(workspaceId, planId, input, payload));
      locks.set(key, operation);
      try {
        const result = await operation;
        res.status(result.duplicate ? 200 : input.target === 'manual' ? 201 : 202).set('Cache-Control', 'no-store').json(result);
      } finally { if (locks.get(key) === operation) locks.delete(key); }
    })().catch((error: unknown) => {
      const detail = error as { statusCode?: number; status?: number; code?: string; message?: string };
      const status = detail.statusCode ?? detail.status ?? 500;
      res.status(status).json({ code: detail.code ?? 'HANDOFF_FAILED',
        error: status < 500 ? detail.message : 'Planning handoff could not finish. Retry with the same handoff ID.' });
    });
  });
}
