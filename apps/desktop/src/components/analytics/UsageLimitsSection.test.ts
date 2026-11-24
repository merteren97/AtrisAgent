import assert from 'node:assert/strict';
import type { QuotaWindow } from '@/lib/activity-types';
import {
  clampPercent,
  formatResetCountdown,
  getQuotaTone,
  groupQuotaWindows,
} from './UsageLimitsSection';

// clampPercent
assert.equal(clampPercent(50), 50);
assert.equal(clampPercent(0), 0);
assert.equal(clampPercent(100), 100);
assert.equal(clampPercent(-15), 0);
assert.equal(clampPercent(142), 100);
assert.equal(clampPercent(Number.NaN), 0);
assert.equal(clampPercent(Number.POSITIVE_INFINITY), 0);

// formatResetCountdown
const nowMs = Date.parse('2026-11-24T12:00:00.000Z');
assert.equal(formatResetCountdown(null, nowMs), '');
assert.equal(formatResetCountdown('not-a-date', nowMs), '');
assert.equal(formatResetCountdown('2026-11-24T11:55:00.000Z', nowMs), 'Resetting soon');
assert.equal(formatResetCountdown('2026-11-24T12:00:00.000Z', nowMs), 'Resetting soon');
assert.equal(formatResetCountdown('2026-11-24T12:00:45.000Z', nowMs), 'Resetting soon');
assert.equal(formatResetCountdown('2026-11-24T12:12:00.000Z', nowMs), 'Resets in 12m');
assert.equal(formatResetCountdown('2026-11-24T16:40:00.000Z', nowMs), 'Resets in 4h 40m');
assert.equal(formatResetCountdown('2026-11-24T15:00:00.000Z', nowMs), 'Resets in 3h');
assert.equal(formatResetCountdown('2026-11-30T20:00:00.000Z', nowMs), 'Resets in 6d 8h');
assert.equal(formatResetCountdown('2026-11-26T12:00:00.000Z', nowMs), 'Resets in 2d');

// getQuotaTone
assert.equal(getQuotaTone(0), 'critical');
assert.equal(getQuotaTone(10), 'critical');
assert.equal(getQuotaTone(-5), 'critical');
assert.equal(getQuotaTone(11), 'warning');
assert.equal(getQuotaTone(25), 'warning');
assert.equal(getQuotaTone(26), 'healthy');
assert.equal(getQuotaTone(88), 'healthy');
assert.equal(getQuotaTone(100), 'healthy');

// groupQuotaWindows: grouped Antigravity windows preserve order & descriptions
const antigravityWindows: QuotaWindow[] = [
  {
    id: 'ag-gemini-5h',
    label: '5-Hour Limit',
    group: 'Gemini Models',
    groupDescription: 'Shared across Gemini 2.5 Pro and Flash',
    windowKind: 'five_hour',
    usedPercent: 12,
    remainingPercent: 88,
    resetsAt: '2026-11-24T16:40:00.000Z',
  },
  {
    id: 'ag-claude-5h',
    label: '5-Hour Limit',
    group: 'Claude and GPT models',
    groupDescription: 'Shared across Claude and GPT models',
    windowKind: 'five_hour',
    usedPercent: 40,
    remainingPercent: 60,
    resetsAt: '2026-11-24T15:00:00.000Z',
  },
  {
    id: 'ag-gemini-weekly',
    label: 'Weekly Limit',
    group: 'Gemini Models',
    windowKind: 'weekly',
    usedPercent: 20,
    remainingPercent: 80,
    resetsAt: '2026-11-30T20:00:00.000Z',
  },
];

const grouped = groupQuotaWindows(antigravityWindows);
assert.equal(grouped.length, 2);
assert.equal(grouped[0].group, 'Gemini Models');
assert.equal(grouped[0].description, 'Shared across Gemini 2.5 Pro and Flash');
assert.deepEqual(
  grouped[0].windows.map((w) => w.id),
  ['ag-gemini-5h', 'ag-gemini-weekly'],
);
assert.equal(grouped[1].group, 'Claude and GPT models');
assert.deepEqual(
  grouped[1].windows.map((w) => w.id),
  ['ag-claude-5h'],
);

// groupQuotaWindows: ungrouped Codex windows
const codexWindows: QuotaWindow[] = [
  {
    id: 'codex-5h',
    label: '5-Hour Limit',
    windowKind: 'five_hour',
    usedPercent: 15,
    remainingPercent: 85,
    resetsAt: '2026-11-24T16:00:00.000Z',
  },
  {
    id: 'codex-weekly',
    label: 'Weekly Limit',
    windowKind: 'weekly',
    usedPercent: 30,
    remainingPercent: 70,
    resetsAt: '2026-11-29T12:00:00.000Z',
  },
];

const ungrouped = groupQuotaWindows(codexWindows);
assert.equal(ungrouped.length, 1);
assert.equal(ungrouped[0].group, null);
assert.equal(ungrouped[0].windows.length, 2);

console.log('usage limits section tests passed');
