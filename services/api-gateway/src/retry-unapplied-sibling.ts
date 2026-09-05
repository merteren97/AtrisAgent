import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { validateDirectChildProjectName } from '@atris-agent-code/domain';

const LEGACY_FAILURE = 'New sibling apply metadata or idempotency key is missing.';

/** Narrow repair for the legacy auto-apply bug, not a generic replay of failed writes. */
export function claimUnappliedSiblingRetry(
  sqlite: Database.Database,
  missionId: string,
  authorize: (mission: { execution_mode: string; automation_policy: string | null }) => void,
): boolean {
  return sqlite.transaction(() => {
    const mission = sqlite.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as any;
    if (!mission || mission.status !== 'blocked' || !mission.plan_id || mission.active_run_id) return false;
    const failure = sqlite.prepare("SELECT payload FROM mission_events WHERE mission_id = ? AND type = 'mission_failed' ORDER BY sequence DESC LIMIT 1")
      .get(missionId) as { payload: string } | undefined;
    if (!failure || JSON.parse(failure.payload).reason !== LEGACY_FAILURE) return false;
    if (sqlite.prepare('SELECT 1 FROM apply_verification_operations WHERE mission_id = ? AND plan_id = ?').get(missionId, mission.plan_id)) {
      throw new Error('An apply operation already exists; reconcile its recorded state instead of replaying it.');
    }
    if (sqlite.prepare("SELECT 1 FROM mission_runs WHERE mission_id = ? AND status IN ('starting', 'running', 'stopping')").get(missionId)
      || sqlite.prepare("SELECT 1 FROM mission_commands WHERE mission_id = ? AND status IN ('pending', 'processing')").get(missionId)) {
      throw new Error('Finish or cancel pending conversation turns before retrying publication.');
    }
    const tasks = sqlite.prepare('SELECT * FROM tasks WHERE mission_id = ? AND plan_id = ?').all(missionId, mission.plan_id) as any[];
    const builders = tasks.filter((task) => task.assigned_role === 'builder');
    const reviewers = tasks.filter((task) => task.assigned_role === 'reviewer');
    const qa = tasks.filter((task) => task.assigned_role === 'qa');
    if (!builders.length || !reviewers.length || !qa.length || tasks.some((task) => task.status !== 'done')) {
      throw new Error('Completed Builder, Reviewer and QA tasks are required before publication retry.');
    }
    for (const task of [...reviewers, ...qa]) {
      const type = task.assigned_role === 'reviewer' ? 'review_completed' : 'verification_completed';
      const row = sqlite.prepare('SELECT payload FROM mission_events WHERE mission_id = ? AND type = ? AND task_id = ? ORDER BY sequence DESC LIMIT 1')
        .get(missionId, type, task.id) as { payload: string } | undefined;
      const event = row ? JSON.parse(row.payload) : null;
      if (!event || (type === 'review_completed' ? event.approved : event.passed) !== true) {
        throw new Error('Persisted passing Reviewer and QA verdicts are required before publication retry.');
      }
    }
    authorize(mission);
    const workspace = sqlite.prepare('SELECT path FROM workspaces WHERE id = ?').get(mission.workspace_id) as { path: string } | undefined;
    if (!workspace?.path) throw new Error('Mission workspace is missing.');
    const container = fs.realpathSync.native(workspace.path);
    const targetNames = new Set<string>();
    for (const task of builders) {
      const records = sqlite.prepare('SELECT * FROM worktrees WHERE task_id = ?').all(task.id) as any[];
      const worktree = records[0];
      if (records.length !== 1 || worktree.isolation_kind !== 'new-sibling' || worktree.status !== 'active'
        || worktree.applied_operation_key || worktree.canonical_container !== container || worktree.path !== task.worktree_id) {
        throw new Error('Publication retry requires one intact, unapplied new-sibling worktree per Builder.');
      }
      const name = validateDirectChildProjectName(worktree.target_name);
      const key = name.toLocaleLowerCase('en-US');
      if (targetNames.has(key)) throw new Error('Multiple Builder outputs target the same project.');
      targetNames.add(key);
      if (worktree.target_path !== path.join(container, name)
        || fs.readdirSync(container).some((entry) => entry.toLocaleLowerCase('en-US') === key)) {
        throw new Error('The publication destination exists or changed; no files will be overwritten.');
      }
      const staging = fs.realpathSync.native(task.worktree_id);
      const relative = path.relative(path.join(container, '.atris-worktrees'), staging);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
        || !fs.statSync(path.join(staging, '.atris-baseline')).isDirectory()) {
        throw new Error('The original managed staging directory could not be verified.');
      }
    }
    // Transaction owns the transition; a second retry cannot claim this plan.
    return sqlite.prepare("UPDATE missions SET status = 'applying', completed_at = NULL, updated_at = ? WHERE id = ? AND plan_id = ? AND status = 'blocked' AND active_run_id IS NULL")
      .run(new Date().toISOString(), missionId, mission.plan_id).changes === 1;
  })();
}
