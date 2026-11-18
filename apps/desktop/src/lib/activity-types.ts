export type ActivityMode = 'manual' | 'orchestrator' | 'planning';
export type ActivityState = 'attention' | 'running' | 'completed' | 'failed' | 'cancelled' | 'idle';
export type ActivityAttentionKind = 'question' | 'approval' | 'blocked' | 'error';
export type CliProviderId = 'claude_code' | 'codex' | 'antigravity' | 'opencode';

export interface ActivityTarget {
  mode: ActivityMode;
  workspaceId: string;
  conversationId?: string;
  missionId?: string;
  planId?: string;
  agentId?: string;
}

export interface ActivityAttentionInfo {
  kind: ActivityAttentionKind;
  preview: string;
  sinceAt: string;
  agentId?: string;
}

export interface ActivityManualAgentSnapshot {
  id: string;
  name: string;
  runtimeType: string;
  model: string;
  rawState: 'ready' | 'working' | 'attention' | 'completed' | 'unknown';
  activityAt?: number;
  attentionPreview?: string;
}

export interface ActivitySummaryItem {
  itemKey: string;
  mode: ActivityMode;
  workspaceId: string;
  workspaceName: string;
  title: string;
  subtitle?: string;
  state: ActivityState;
  statusLabel: string;
  runtimeTypes: string[];
  models: string[];
  activeCount: number;
  totalAgentCount: number;
  attention: ActivityAttentionInfo | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  createdAt: string;
  durationMs: number | null;
  pinnedAt: string | null;
  unreadCompletion: boolean;
  target: ActivityTarget;
  manualAgents?: ActivityManualAgentSnapshot[];
}

export interface ActivitySummaryResponse {
  items: ActivitySummaryItem[];
  counts: {
    attention: number;
    running: number;
    unreadCompleted: number;
    total: number;
  };
  generatedAt: string;
}

export type InsightsTimeRange = 'today' | '7d' | '30d' | 'all';

export interface InsightsProviderBreakdown {
  provider: CliProviderId;
  label: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  totalCostUsd: number | null;
  sessionCount: number;
  turnCount: number;
  totalDurationMs: number;
  tokenReportingCount: number;
}

export interface InsightsModeBreakdown {
  mode: ActivityMode;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  runCount: number;
  totalDurationMs: number;
}

export interface InsightsDailyPoint {
  date: string;
  totalTokens: number;
  byProvider: Partial<Record<CliProviderId, number>>;
}

export interface InsightsTopSession {
  itemKey: string;
  title: string;
  workspaceId: string;
  workspaceName: string;
  mode: ActivityMode;
  provider: CliProviderId | 'mixed';
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  durationMs: number;
  turnCount: number;
  usageAvailable: boolean;
  recordedAt: string;
  target: ActivityTarget;
}

export interface InsightsUsageResponse {
  range: InsightsTimeRange;
  workspaceId: string | null;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    totalCostUsd: number | null;
    totalDurationMs: number;
    totalRuns: number;
    tokenReportedRuns: number;
  };
  byProvider: InsightsProviderBreakdown[];
  byMode: InsightsModeBreakdown[];
  daily: InsightsDailyPoint[];
  topSessions: InsightsTopSession[];
  generatedAt: string;
}
