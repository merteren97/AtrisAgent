import assert from 'node:assert/strict';
import type { InsightsProviderBreakdown, InsightsTopSession } from '@/lib/activity-types';
import {
  buildInsightsUsageUrl,
  computeProviderShares,
  filterTopSessions,
  formatExactNumber,
  formatRelativeWhen,
  formatShortDay,
  formatTokenCount,
  formatUsd,
  getTelemetryCoveragePercent,
  normalizeModeBreakdowns,
  normalizeProviderBreakdowns,
} from './Dashboard';

// buildInsightsUsageUrl
assert.equal(buildInsightsUsageUrl('7d', null), '/insights/usage?range=7d');
assert.equal(buildInsightsUsageUrl('today', ''), '/insights/usage?range=today');
assert.equal(
  buildInsightsUsageUrl('30d', 'ws-alpha/1'),
  '/insights/usage?range=30d&workspaceId=ws-alpha%2F1',
);
assert.equal(buildInsightsUsageUrl('all', 'ws-2'), '/insights/usage?range=all&workspaceId=ws-2');

// formatTokenCount
assert.equal(formatTokenCount(0), '0');
assert.equal(formatTokenCount(-42), '0');
assert.equal(formatTokenCount(null), '0');
assert.equal(formatTokenCount(undefined), '0');
assert.equal(formatTokenCount(Number.NaN), '0');
assert.equal(formatTokenCount(Number.POSITIVE_INFINITY), '0');
assert.equal(formatTokenCount(842), '842');
assert.equal(formatTokenCount(1_000), '1K');
assert.equal(formatTokenCount(420_500), '420.5K');
assert.equal(formatTokenCount(999_950), '1M');
assert.equal(formatTokenCount(1_280_000), '1.28M');
assert.equal(formatTokenCount(2_000_000), '2M');
assert.equal(formatTokenCount(1_500_000_000), '1.5B');

// formatExactNumber
assert.equal(formatExactNumber(0), '0');
assert.equal(formatExactNumber(null), '0');
assert.equal(formatExactNumber(1_280_000), '1,280,000');

// formatUsd
assert.equal(formatUsd(null), null);
assert.equal(formatUsd(undefined), null);
assert.equal(formatUsd(0), null);
assert.equal(formatUsd(-1), null);
assert.equal(formatUsd(0.004), '<$0.01');
assert.equal(formatUsd(12.345), '$12.35');

// formatShortDay & formatRelativeWhen
assert.equal(formatShortDay('2026-11-18'), 'Nov 18');
assert.equal(formatShortDay('not-a-date'), 'not-a-date');

const nowMs = Date.parse('2026-11-18T12:00:00.000Z');
assert.equal(formatRelativeWhen('2026-11-18T11:59:30.000Z', nowMs), 'Just now');
assert.equal(formatRelativeWhen('2026-11-18T11:45:00.000Z', nowMs), '15m ago');
assert.equal(formatRelativeWhen('2026-11-18T09:00:00.000Z', nowMs), '3h ago');
assert.equal(formatRelativeWhen('2026-11-16T12:00:00.000Z', nowMs), '2d ago');
assert.equal(formatRelativeWhen('2026-10-01T12:00:00.000Z', nowMs), 'Oct 1');
assert.equal(formatRelativeWhen('2025-10-01T12:00:00.000Z', nowMs), 'Oct 1, 2025');
assert.equal(formatRelativeWhen('bad-date', nowMs), '—');

// normalizeProviderBreakdowns
const partialProviders: InsightsProviderBreakdown[] = [
  {
    provider: 'codex',
    label: 'Codex',
    inputTokens: 1_000,
    outputTokens: 500,
    cachedTokens: 200,
    reasoningTokens: 100,
    totalTokens: 1_800,
    totalCostUsd: 0.12,
    sessionCount: 2,
    turnCount: 6,
    totalDurationMs: 45_000,
    tokenReportingCount: 2,
  },
  {
    provider: 'claude_code',
    label: 'Claude Code',
    inputTokens: 3_000,
    outputTokens: 1_200,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 4_200,
    totalCostUsd: 0.35,
    sessionCount: 3,
    turnCount: 10,
    totalDurationMs: 90_000,
    tokenReportingCount: 3,
  },
];

const normalized = normalizeProviderBreakdowns(partialProviders);
assert.equal(normalized.length, 4);
assert.deepEqual(
  normalized.map((p) => p.provider),
  ['claude_code', 'codex', 'antigravity', 'opencode'],
);
assert.equal(normalized[2].totalTokens, 0);
assert.equal(normalized[3].label, 'OpenCode');

// computeProviderShares: token basis
const tokenShares = computeProviderShares(partialProviders);
assert.equal(tokenShares.basis, 'tokens');
assert.equal(tokenShares.totalValue, 6_000);
assert.equal(Math.round(tokenShares.items[0].percent), 70);
assert.equal(Math.round(tokenShares.items[1].percent), 30);
assert.equal(tokenShares.items[2].percent, 0);

// computeProviderShares: fallback to turns when totalTokens === 0
const zeroTokenTurnProviders: InsightsProviderBreakdown[] = [
  {
    provider: 'antigravity',
    label: 'Antigravity',
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    totalCostUsd: null,
    sessionCount: 2,
    turnCount: 8,
    totalDurationMs: 60_000,
    tokenReportingCount: 0,
  },
  {
    provider: 'opencode',
    label: 'OpenCode',
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    totalCostUsd: null,
    sessionCount: 1,
    turnCount: 2,
    totalDurationMs: 15_000,
    tokenReportingCount: 0,
  },
];
const turnShares = computeProviderShares(zeroTokenTurnProviders);
assert.equal(turnShares.basis, 'turns');
assert.equal(turnShares.totalValue, 10);
assert.equal(turnShares.items[0].provider, 'antigravity');
assert.equal(turnShares.items[0].percent, 80);
assert.equal(turnShares.items[1].percent, 20);

// computeProviderShares: fallback to sessions when tokens and turns are 0
const zeroTurnSessionProviders: InsightsProviderBreakdown[] = [
  {
    ...zeroTokenTurnProviders[0],
    turnCount: 0,
    sessionCount: 3,
  },
  {
    ...zeroTokenTurnProviders[1],
    turnCount: 0,
    sessionCount: 1,
  },
];
const sessionShares = computeProviderShares(zeroTurnSessionProviders);
assert.equal(sessionShares.basis, 'sessions');
assert.equal(sessionShares.items[0].percent, 75);
assert.equal(sessionShares.items[1].percent, 25);

// computeProviderShares: empty / none basis
const emptyShares = computeProviderShares([]);
assert.equal(emptyShares.basis, 'none');
assert.equal(emptyShares.items.length, 4);
assert.ok(emptyShares.items.every((item) => item.percent === 0));

// normalizeModeBreakdowns
const normalizedModes = normalizeModeBreakdowns([
  {
    mode: 'planning',
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 150,
    runCount: 1,
    totalDurationMs: 5_000,
  },
]);
assert.deepEqual(
  normalizedModes.map((m) => m.mode),
  ['manual', 'orchestrator', 'planning'],
);
assert.equal(normalizedModes[0].runCount, 0);
assert.equal(normalizedModes[2].totalTokens, 150);

// filterTopSessions
const sampleSessions: InsightsTopSession[] = [
  {
    itemKey: 's-1',
    title: 'Fix auth token refresh',
    workspaceId: 'ws-1',
    workspaceName: 'AtrisAgent',
    mode: 'manual',
    provider: 'claude_code',
    inputTokens: 1_000,
    outputTokens: 500,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 1_500,
    durationMs: 30_000,
    turnCount: 4,
    usageAvailable: true,
    recordedAt: '2026-11-18T11:00:00.000Z',
    target: { mode: 'manual', workspaceId: 'ws-1', conversationId: 'c-1' },
  },
  {
    itemKey: 's-2',
    title: 'Multi-agent refactor',
    workspaceId: 'ws-1',
    workspaceName: 'AtrisAgent',
    mode: 'orchestrator',
    provider: 'mixed',
    inputTokens: 4_000,
    outputTokens: 2_000,
    cachedTokens: 500,
    reasoningTokens: 500,
    totalTokens: 7_000,
    durationMs: 120_000,
    turnCount: 12,
    usageAvailable: true,
    recordedAt: '2026-11-18T10:00:00.000Z',
    target: { mode: 'orchestrator', workspaceId: 'ws-1', missionId: 'm-1' },
  },
  {
    itemKey: 's-3',
    title: 'Plan insights schema',
    workspaceId: 'ws-2',
    workspaceName: 'Docs',
    mode: 'planning',
    provider: 'codex',
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    durationMs: 25_000,
    turnCount: 3,
    usageAvailable: false,
    recordedAt: '2026-11-18T09:00:00.000Z',
    target: { mode: 'planning', workspaceId: 'ws-2', planId: 'p-1' },
  },
];

assert.equal(filterTopSessions(sampleSessions, 'all').length, 3);
assert.deepEqual(
  filterTopSessions(sampleSessions, 'claude_code').map((s) => s.itemKey),
  ['s-1'],
);
assert.deepEqual(
  filterTopSessions(sampleSessions, 'codex').map((s) => s.itemKey),
  ['s-3'],
);
assert.equal(filterTopSessions(sampleSessions, 'antigravity').length, 0);

// getTelemetryCoveragePercent
assert.equal(getTelemetryCoveragePercent(0, 0), 0);
assert.equal(getTelemetryCoveragePercent(3, 4), 75);
assert.equal(getTelemetryCoveragePercent(10, 4), 100);

console.log('insights dashboard tests passed');
