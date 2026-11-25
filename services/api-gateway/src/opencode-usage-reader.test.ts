import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { listRecentOpenCodeSessions, readOpenCodeSessionUsage } from './opencode-usage-reader';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-oc-usage-'));

try {
  // 1. Mixed v1 (session/message) + v2 (session_v2/session_message) DB
  const mixedDbPath = path.join(root, 'mixed.db');
  const db = new Database(mixedDbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT,
      time_created INTEGER, time_updated INTEGER,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
    );
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT,
      time_created INTEGER, time_updated INTEGER,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
  `);

  db.prepare(`INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'ses_v1_only', 'V1 Session', '/proj/v1', 1700000000000, 1700000010000, 100, 20, 5, 10, 0, 0.01,
  );
  db.prepare(`INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'ses_shared', 'Legacy Shared', '/proj/shared', 1700000000000, 1700000020000, 50, 10, 0, 0, 0, 0.005,
  );

  db.prepare(`INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'ses_v2_only', 'V2 Session', '/proj/v2', 1700000050000, 1700000060000, 400, 80, 15, 30, 5, 0.04,
  );
  db.prepare(`INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'ses_shared', 'V2 Shared', '/proj/shared', 1700000000000, 1700000070000, 500, 90, 0, 0, 0, 0.05,
  );
  db.prepare(`INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'msg_v2_1', 'ses_v2_only', 'assistant', 1, 1700000051000, 1700000060000,
    JSON.stringify({
      role: 'assistant',
      providerID: 'openai',
      modelID: 'gpt-5',
      tokens: { input: 400, output: 80, reasoning: 15, cache: { read: 30, write: 5 } },
      cost: 0.04,
    }),
  );
  db.close();

  const v1 = readOpenCodeSessionUsage('ses_v1_only', { dbPath: mixedDbPath });
  assert.ok(v1);
  assert.equal(v1.title, 'V1 Session');
  assert.equal(v1.inputTokens, 100);
  assert.equal(v1.cachedTokens, 10);

  const v2 = readOpenCodeSessionUsage('ses_v2_only', { dbPath: mixedDbPath });
  assert.ok(v2);
  assert.equal(v2.title, 'V2 Session');
  assert.equal(v2.model, 'openai/gpt-5');
  assert.equal(v2.inputTokens, 400);
  assert.equal(v2.outputTokens, 80);
  assert.equal(v2.reasoningTokens, 15);
  assert.equal(v2.cachedTokens, 35);
  assert.equal(v2.totalCostUsd, 0.04);

  const shared = readOpenCodeSessionUsage('ses_shared', { dbPath: mixedDbPath });
  assert.ok(shared);
  assert.equal(shared.title, 'V2 Shared', 'v2 takes precedence when session id exists in both');
  assert.equal(shared.inputTokens, 500);

  const recent = listRecentOpenCodeSessions({ dbPath: mixedDbPath });
  assert.deepEqual(
    recent.map((s) => s.sessionId),
    ['ses_shared', 'ses_v2_only', 'ses_v1_only'],
    'dedupes across v1 and v2 and sorts newest first',
  );

  // 2. v2-only DB without legacy v1 tables
  const v2OnlyDbPath = path.join(root, 'v2only.db');
  const db2 = new Database(v2OnlyDbPath);
  db2.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT,
      time_created INTEGER, time_updated INTEGER,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
  `);
  db2.prepare(`INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'ses_pure_v2', 'Pure V2', '/proj/pure', 1700000100000, 1700000110000, 250, 50, 0, 0, 0, 0.02,
  );
  db2.close();

  const pureV2 = readOpenCodeSessionUsage('ses_pure_v2', { dbPath: v2OnlyDbPath });
  assert.ok(pureV2);
  assert.equal(pureV2.inputTokens, 250);
  assert.equal(listRecentOpenCodeSessions({ dbPath: v2OnlyDbPath }).length, 1);

  console.log('OpenCode usage reader v1 + v2 tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
