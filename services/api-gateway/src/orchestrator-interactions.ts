import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type { AgentEvent, QuestionAsked, QuestionCorrelation } from '@atris-agent-code/event-schema';

export type QuestionStatus = 'pending' | 'delivering' | 'delivered' | 'accepted' | 'delivery_failed' | 'rejected' | 'cancelled' | 'stale';
export interface OrchestratorQuestion extends QuestionAsked {
  status: QuestionStatus;
  answers?: string[][];
  clientRequestId?: string;
  error?: string;
  updatedAt: string;
  acceptedAt?: string;
  deliveredAt?: string;
  providerAcceptedAt?: string;
}
export interface QuestionReplyResult {
  /** Gateway durably accepted the request; this does not imply delivery. */
  accepted: boolean;
  delivered: boolean;
  providerAccepted: boolean;
  question: OrchestratorQuestion;
}
export interface QuestionRuntime {
  isRuntimeQuestionActive(question: QuestionAsked): boolean;
  respondToRuntimeQuestion(question: QuestionAsked, answers: string[][]): Promise<void>;
  rejectRuntimeQuestion(question: QuestionAsked): Promise<void>;
}
export interface OrchestratorInteractionsDependencies {
  sqlite: BetterSqlite3.Database;
  eventBus: LocalEventBus;
  runtimeHost: QuestionRuntime;
}

const RESOLVED = new Set<QuestionStatus>(['accepted', 'rejected', 'cancelled', 'stale']);
const param = (value: string | string[]) => Array.isArray(value) ? value[0] || '' : value;
class InteractionError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

/** Isolated additive schema, in the gateway's existing SQLite database. */
export class OrchestratorQuestionStore {
  constructor(private readonly sqlite: BetterSqlite3.Database) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_questions (
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (mission_id, question_id)
      );
      CREATE TABLE IF NOT EXISTS orchestrator_question_replies (
        mission_id TEXT NOT NULL, question_id TEXT NOT NULL, client_request_id TEXT NOT NULL,
        action TEXT NOT NULL, answers TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
        PRIMARY KEY (mission_id, question_id, client_request_id),
        FOREIGN KEY (mission_id, question_id) REFERENCES orchestrator_questions(mission_id, question_id) ON DELETE CASCADE
      );
    `);
  }

  get(missionId: string, questionId: string): OrchestratorQuestion | undefined {
    const row = this.sqlite.prepare('SELECT payload FROM orchestrator_questions WHERE mission_id = ? AND question_id = ?')
      .get(missionId, questionId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  list(missionId: string): OrchestratorQuestion[] {
    return (this.sqlite.prepare('SELECT payload FROM orchestrator_questions WHERE mission_id = ?').all(missionId) as { payload: string }[])
      .map(row => JSON.parse(row.payload) as OrchestratorQuestion).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  private save(question: OrchestratorQuestion): void {
    this.sqlite.prepare(`INSERT INTO orchestrator_questions (mission_id, question_id, payload) VALUES (?, ?, ?)
      ON CONFLICT(mission_id, question_id) DO UPDATE SET payload = excluded.payload`)
      .run(question.missionId, question.questionId, JSON.stringify(question));
  }

  update(missionId: string, questionId: string, patch: Partial<OrchestratorQuestion>): OrchestratorQuestion | undefined {
    const question = this.get(missionId, questionId);
    if (!question) return undefined;
    const updated = { ...question, ...patch, updatedAt: new Date().toISOString() };
    this.save(updated);
    return updated;
  }

  ingest(event: AgentEvent): void {
    if (event.type === 'question_asked') {
      if (!this.get(event.missionId, event.questionId)) this.save({ ...event, status: 'pending', updatedAt: event.timestamp });
      return;
    }
    if (event.type === 'question_replied' || event.type === 'question_rejected') {
      const question = this.get(event.missionId, event.questionId);
      if (!question || !matches(question, event) || RESOLVED.has(question.status)) return;
      if (event.type === 'question_replied') {
        this.update(event.missionId, event.questionId, { status: 'accepted', answers: event.answers,
          deliveredAt: question.deliveredAt || event.timestamp, providerAcceptedAt: event.timestamp, error: undefined });
      } else this.update(event.missionId, event.questionId, { status: event.outcome, error: event.reason,
        ...(event.outcome === 'rejected' && question.clientRequestId && question.answers?.length === 0 ? { deliveredAt: event.timestamp } : {}) });
      return;
    }
    // Ownership comes from run/turn and attempt IDs, never event arrival timestamps.
    if (!['task_completed', 'task_failed', 'agent_cancelled', 'mission_completed', 'mission_failed'].includes(event.type)) return;
    for (const question of this.list(event.missionId)) {
      if (RESOLVED.has(question.status)) continue;
      const identity = event as AgentEvent & { taskId?: string; agentInstanceId?: string; attemptId?: string };
      if (event.runId || event.turnId) {
        if (event.turnId && question.turnId && event.turnId !== question.turnId) continue;
        const eventRun = this.correlatedRun(event);
        // Conflicting IDs cannot establish ownership, even if one matches.
        if (event.runId && event.turnId && this.correlatedRun({ missionId: event.missionId, turnId: event.turnId }) !== event.runId) continue;
        if (eventRun ? this.correlatedRun(question) !== eventRun
          : question.runId || !event.turnId || question.turnId !== event.turnId) continue;
      } else if (event.type === 'mission_completed' || event.type === 'mission_failed') {
        if (!this.isSafelyTerminal(event.missionId)) continue;
      }
      if (identity.taskId && question.attemptId && !identity.agentInstanceId && !identity.attemptId) continue;
      if (identity.taskId && identity.taskId !== question.taskId) continue;
      if (identity.agentInstanceId && identity.agentInstanceId !== question.agentInstanceId) continue;
      if (identity.attemptId && identity.attemptId !== question.attemptId) continue;
      this.update(question.missionId, question.questionId, { status: 'cancelled', error: 'Originating task or mission ended.' });
    }
  }

  private hasTable(name: string): boolean {
    return Boolean(this.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  /** Supervisor asks carry a turn; resolve only an unambiguous durable run. */
  private correlatedRun(identity: { missionId: string; runId?: string; turnId?: string }): string | undefined {
    if (identity.runId) return identity.runId;
    if (!identity.turnId || !this.hasTable('mission_runs')) return undefined;
    const runs = this.sqlite.prepare('SELECT id FROM mission_runs WHERE mission_id = ? AND turn_id = ? LIMIT 2')
      .all(identity.missionId, identity.turnId) as { id: string }[];
    return runs.length === 1 ? runs[0].id : undefined;
  }

  private isSafelyTerminal(missionId: string): boolean {
    const mission = this.sqlite.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as
      { status: string; active_run_id?: string | null } | undefined;
    if (!mission || !['completed', 'failed', 'cancelled'].includes(mission.status) || mission.active_run_id) return false;
    if (this.hasTable('mission_runs') && this.sqlite.prepare(`SELECT 1 FROM mission_runs
      WHERE mission_id = ? AND status IN ('starting', 'running', 'stopping') LIMIT 1`).get(missionId)) return false;
    if (this.hasTable('conversation_turns') && this.sqlite.prepare(`SELECT 1 FROM conversation_turns
      WHERE mission_id = ? AND status IN ('queued', 'pending_priority', 'starting', 'running') LIMIT 1`).get(missionId)) return false;
    return true;
  }

  /** The claim and idempotency evidence are committed before invoking any runtime side effect. */
  claim(question: OrchestratorQuestion, clientRequestId: string, action: 'reply' | 'cancel', answers: string[][]): boolean {
    return this.sqlite.transaction(() => {
      const previous = this.sqlite.prepare(`SELECT action, answers, status FROM orchestrator_question_replies
        WHERE mission_id = ? AND question_id = ? AND client_request_id = ?`)
        .get(question.missionId, question.questionId, clientRequestId) as { action: string; answers: string; status: string } | undefined;
      const encoded = JSON.stringify(answers);
      if (previous && (previous.action !== action || previous.answers !== encoded)) throw new InteractionError(409, 'clientRequestId was already used for a different response.');
      const current = this.get(question.missionId, question.questionId)!;
      if (RESOLVED.has(current.status) || current.status === 'delivered' || current.status === 'delivering') return false;
      if (previous && previous.status !== 'failed') return false;
      this.sqlite.prepare(`INSERT INTO orchestrator_question_replies (mission_id, question_id, client_request_id, action, answers, status)
        VALUES (?, ?, ?, ?, ?, 'delivering') ON CONFLICT(mission_id, question_id, client_request_id)
        DO UPDATE SET status = 'delivering', error = NULL`)
        .run(question.missionId, question.questionId, clientRequestId, action, encoded);
      this.update(question.missionId, question.questionId, { status: 'delivering', clientRequestId, answers,
        acceptedAt: new Date().toISOString(), error: undefined });
      return true;
    })();
  }

  finish(question: QuestionAsked, clientRequestId: string, error?: string): OrchestratorQuestion {
    return this.sqlite.transaction(() => {
      this.sqlite.prepare(`UPDATE orchestrator_question_replies SET status = ?, error = ?
        WHERE mission_id = ? AND question_id = ? AND client_request_id = ?`)
        .run(error ? 'failed' : 'delivered', error || null, question.missionId, question.questionId, clientRequestId);
      const current = this.get(question.missionId, question.questionId)!;
      // Provider acceptance/cancellation can arrive synchronously before the HTTP response.
      if (!RESOLVED.has(current.status) && current.clientRequestId === clientRequestId) {
        return this.update(question.missionId, question.questionId, { status: error ? 'delivery_failed' : 'delivered', error,
          ...(!error ? { deliveredAt: new Date().toISOString() } : {}) })!;
      }
      return current;
    })();
  }

  recoverInterrupted(): void {
    this.sqlite.prepare("UPDATE orchestrator_question_replies SET status = 'failed', error = 'Gateway restarted during delivery' WHERE status = 'delivering'").run();
    for (const row of this.sqlite.prepare('SELECT payload FROM orchestrator_questions').all() as { payload: string }[]) {
      const question = JSON.parse(row.payload) as OrchestratorQuestion;
      if (question.status === 'delivering') this.update(question.missionId, question.questionId, {
        status: 'delivery_failed', error: 'Gateway restarted before delivery was confirmed. Reload to check the originating session.',
      });
    }
  }
}

function matches(question: QuestionAsked, event: QuestionCorrelation): boolean {
  return question.requestId === event.requestId && question.agentInstanceId === event.agentInstanceId
    && question.runtimeSessionId === event.runtimeSessionId && question.attemptId === event.attemptId
    && question.taskId === event.taskId && question.adapterId === event.adapterId;
}

export function validateQuestionAnswers(question: QuestionAsked, value: unknown): string[][] {
  if (!Array.isArray(value) || value.length !== question.questions.length) throw new InteractionError(400, 'Provide one answer array per question.');
  return value.map((answers, index) => {
    const info = question.questions[index];
    if (!Array.isArray(answers) || !answers.length || answers.length > 100
      || answers.some(answer => typeof answer !== 'string' || !answer.trim() || answer.length > 16_000)) {
      throw new InteractionError(400, 'Answers must contain non-empty strings (up to 16000 characters).');
    }
    if (!info.multiple && answers.length !== 1) throw new InteractionError(400, 'Choose one answer for a single-choice question.');
    if (new Set(answers).size !== answers.length) throw new InteractionError(400, 'Duplicate answers are not allowed.');
    if (info.custom === false && answers.some(answer => !info.options.some(option => option.label === answer))) {
      throw new InteractionError(400, 'This question accepts only the listed choices.');
    }
    return answers as string[];
  });
}

export class OrchestratorInteractions {
  readonly store: OrchestratorQuestionStore;
  private readonly unsubscribe: () => void;
  constructor(private readonly dependencies: OrchestratorInteractionsDependencies) {
    this.store = new OrchestratorQuestionStore(dependencies.sqlite);
    this.store.recoverInterrupted();
    // Existing durable mission events also restore asks emitted before registration.
    const hasEvents = dependencies.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mission_events'").get();
    if (hasEvents) {
      for (const row of dependencies.sqlite.prepare(`SELECT payload FROM mission_events WHERE type IN
        ('question_asked', 'question_replied', 'question_rejected', 'task_completed', 'task_failed', 'agent_cancelled', 'mission_completed', 'mission_failed')
        ORDER BY sequence, created_at`).all() as { payload: string }[]) this.store.ingest(JSON.parse(row.payload));
    }
    this.unsubscribe = dependencies.eventBus.on('*', event => this.store.ingest(event));
  }

  dispose(): void { this.unsubscribe(); }

  private assertMission(missionId: string): { status: string } {
    const mission = this.dependencies.sqlite.prepare('SELECT status FROM missions WHERE id = ?').get(missionId) as { status: string } | undefined;
    if (!mission) throw new InteractionError(404, 'Mission not found.');
    return mission;
  }

  list(missionId: string): { questions: OrchestratorQuestion[] } {
    const mission = this.assertMission(missionId);
    for (const question of this.store.list(missionId)) {
      if (RESOLVED.has(question.status)) continue;
      if (['completed', 'failed', 'cancelled'].includes(mission.status)) {
        this.store.update(missionId, question.questionId, { status: 'cancelled', error: 'Mission ended.' });
      } else if (question.status !== 'delivering' && !this.dependencies.runtimeHost.isRuntimeQuestionActive(question)) {
        this.store.update(missionId, question.questionId, { status: 'stale', error: 'Originating session or task attempt is no longer pending. Retry the task for a new question.' });
      }
    }
    return { questions: this.store.list(missionId) };
  }

  async respond(missionId: string, questionId: string, body: unknown, action: 'reply' | 'cancel' = 'reply'): Promise<QuestionReplyResult> {
    const mission = this.assertMission(missionId);
    if (!body || typeof body !== 'object') throw new InteractionError(400, 'A response body is required.');
    const input = body as Record<string, unknown>;
    if (typeof input.clientRequestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(input.clientRequestId)) throw new InteractionError(400, 'clientRequestId is required (1–160 identifier characters).');
    const question = this.store.get(missionId, questionId);
    if (!question) throw new InteractionError(404, 'Question not found in this mission.');
    const answers = action === 'reply' ? validateQuestionAnswers(question, input.answers) : [];
    // Check duplicate key/body even for already-resolved requests, without sending twice.
    if (['completed', 'failed', 'cancelled'].includes(mission.status) && !RESOLVED.has(question.status)) {
      this.store.update(missionId, questionId, { status: 'cancelled', error: 'Mission ended.' });
    }
    const current = this.store.get(missionId, questionId)!;
    if (!RESOLVED.has(current.status) && current.status !== 'delivering' && current.status !== 'delivered'
      && !this.dependencies.runtimeHost.isRuntimeQuestionActive(question)) {
      this.store.update(missionId, questionId, { status: 'stale', error: 'Originating session or attempt is no longer active.' });
    }
    const claimed = this.store.claim(question, input.clientRequestId, action, answers);
    if (!claimed) return result(this.store.get(missionId, questionId)!);
    this.emitUpdate(question, input.clientRequestId, 'delivering');
    let error: string | undefined;
    try {
      if (action === 'reply') await this.dependencies.runtimeHost.respondToRuntimeQuestion(question, answers);
      else await this.dependencies.runtimeHost.rejectRuntimeQuestion(question);
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    const updated = this.store.finish(question, input.clientRequestId, error);
    if (!RESOLVED.has(updated.status)) this.emitUpdate(question, input.clientRequestId, error ? 'delivery_failed' : 'delivered', error);
    return result(updated);
  }

  private emitUpdate(question: QuestionAsked, clientRequestId: string, status: 'delivering' | 'delivered' | 'delivery_failed', error?: string): void {
    this.dependencies.eventBus.emit({ ...question, id: randomUUID(), type: 'question_reply_updated', clientRequestId, status, error, timestamp: new Date().toISOString() });
  }
}

function result(question: OrchestratorQuestion): QuestionReplyResult {
  return { accepted: Boolean(question.acceptedAt), delivered: Boolean(question.deliveredAt), providerAccepted: Boolean(question.providerAcceptedAt), question };
}

/** Register after the gateway's existing runtime-token and identity/entitlement middleware. */
export function registerOrchestratorInteractions(app: Express, dependencies: OrchestratorInteractionsDependencies): OrchestratorInteractions {
  const interactions = new OrchestratorInteractions(dependencies);
  const fail = (response: Response, error: unknown) => response.status(error instanceof InteractionError ? error.statusCode : 500)
    .json({ error: error instanceof Error ? error.message : 'Question operation failed.' });
  app.get('/api/missions/:id/questions', (request: Request, response: Response) => {
    try { response.json(interactions.list(param(request.params.id))); } catch (error) { fail(response, error); }
  });
  for (const action of ['reply', 'cancel'] as const) {
    app.post(`/api/missions/:id/questions/:questionId/${action}`, async (request: Request, response: Response) => {
      try {
        const reply = await interactions.respond(param(request.params.id), param(request.params.questionId), request.body, action);
        response.status(reply.question.status === 'delivering' ? 202 : 200).json(reply);
      } catch (error) { fail(response, error); }
    });
  }
  return interactions;
}
