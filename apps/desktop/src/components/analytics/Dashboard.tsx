import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Clock3,
  Coins,
  Layers,
  RefreshCw,
  TerminalSquare,
  Workflow,
  X,
} from 'lucide-react';
import type {
  ActivityMode,
  CliProviderId,
  InsightsModeBreakdown,
  InsightsProviderBreakdown,
  InsightsTimeRange,
  InsightsTopSession,
  InsightsUsageResponse,
} from '@/lib/activity-types';
import { formatDurationCompact, navigateToActivityTarget } from '@/lib/activity-navigation';
import { apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';

export const PROVIDER_ORDER: readonly CliProviderId[] = [
  'claude_code',
  'codex',
  'antigravity',
  'opencode',
];

export const MODE_ORDER: readonly ActivityMode[] = ['manual', 'orchestrator', 'planning'];

export const TIME_RANGE_OPTIONS: ReadonlyArray<{ value: InsightsTimeRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

export const PROVIDER_META: Record<
  CliProviderId,
  { label: string; color: string; tintBg: string; tintText: string }
> = {
  claude_code: {
    label: 'Claude Code',
    color: '#d97757',
    tintBg: 'bg-[#d97757]/12',
    tintText: 'text-[#d97757]',
  },
  codex: {
    label: 'Codex',
    color: '#10b981',
    tintBg: 'bg-emerald-500/12',
    tintText: 'text-emerald-600 dark:text-emerald-400',
  },
  antigravity: {
    label: 'Antigravity',
    color: '#6366f1',
    tintBg: 'bg-indigo-500/12',
    tintText: 'text-indigo-600 dark:text-indigo-400',
  },
  opencode: {
    label: 'OpenCode',
    color: '#0ea5e9',
    tintBg: 'bg-sky-500/12',
    tintText: 'text-sky-600 dark:text-sky-400',
  },
};

const MODE_META: Record<ActivityMode, { label: string; icon: typeof TerminalSquare }> = {
  manual: { label: 'Manual', icon: TerminalSquare },
  orchestrator: { label: 'Orchestrator', icon: Workflow },
  planning: { label: 'Planning', icon: BookOpen },
};

const EXACT_NUMBER_FORMATTER = new Intl.NumberFormat('en-US');
const SHORT_DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const SHORT_DATE_WITH_YEAR_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export function buildInsightsUsageUrl(range: InsightsTimeRange, workspaceId: string | null): string {
  return `/insights/usage?range=${range}${workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ''}`;
}

export function formatTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return '0';
  if (value >= 999_950_000) {
    return `${(value / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`;
  }
  if (value >= 999_950) {
    return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(Math.round(value));
}

export function formatExactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return '0';
  return EXACT_NUMBER_FORMATTER.format(Math.round(value));
}

export function formatUsd(cost: number | null | undefined): string | null {
  if (cost === null || cost === undefined || !Number.isFinite(cost) || cost <= 0) return null;
  if (cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

export function formatRelativeWhen(isoString: string, nowMs = Date.now()): string {
  const parsed = Date.parse(isoString);
  if (!Number.isFinite(parsed)) return '—';
  const diffMs = Math.max(0, nowMs - parsed);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(parsed);
  const currentYear = new Date(nowMs).getUTCFullYear();
  if (date.getUTCFullYear() === currentYear) {
    return SHORT_DAY_FORMATTER.format(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())));
  }
  return SHORT_DATE_WITH_YEAR_FORMATTER.format(date);
}

export function formatShortDay(dateStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return SHORT_DAY_FORMATTER.format(new Date(Date.UTC(year, month - 1, day)));
  }
  const parsed = Date.parse(dateStr);
  if (!Number.isFinite(parsed)) return dateStr;
  return SHORT_DAY_FORMATTER.format(new Date(parsed));
}

export function normalizeProviderBreakdowns(
  byProvider: InsightsProviderBreakdown[],
): InsightsProviderBreakdown[] {
  const byId = new Map<CliProviderId, InsightsProviderBreakdown>();
  for (const entry of byProvider) {
    byId.set(entry.provider, entry);
  }
  const normalized = PROVIDER_ORDER.map((provider) => {
    const existing = byId.get(provider);
    if (existing) {
      return {
        ...existing,
        label: existing.label || PROVIDER_META[provider].label,
      };
    }
    return {
      provider,
      label: PROVIDER_META[provider].label,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      totalCostUsd: null,
      sessionCount: 0,
      turnCount: 0,
      totalDurationMs: 0,
      tokenReportingCount: 0,
    };
  });

  return normalized.sort((a, b) => {
    if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
    if (b.turnCount !== a.turnCount) return b.turnCount - a.turnCount;
    if (b.sessionCount !== a.sessionCount) return b.sessionCount - a.sessionCount;
    return PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider);
  });
}

export function normalizeModeBreakdowns(byMode: InsightsModeBreakdown[]): InsightsModeBreakdown[] {
  const byId = new Map<ActivityMode, InsightsModeBreakdown>();
  for (const entry of byMode) {
    byId.set(entry.mode, entry);
  }
  return MODE_ORDER.map((mode) => {
    const existing = byId.get(mode);
    if (existing) return existing;
    return {
      mode,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      runCount: 0,
      totalDurationMs: 0,
    };
  });
}

export type ShareBasis = 'tokens' | 'turns' | 'sessions' | 'none';

export interface ProviderShareItem extends InsightsProviderBreakdown {
  value: number;
  share: number;
  percent: number;
}

export interface ProviderShareResult {
  basis: ShareBasis;
  totalValue: number;
  items: ProviderShareItem[];
}

export function computeProviderShares(
  byProvider: InsightsProviderBreakdown[],
): ProviderShareResult {
  const normalized = normalizeProviderBreakdowns(byProvider);
  const sumTokens = normalized.reduce((acc, item) => acc + Math.max(0, item.totalTokens), 0);
  if (sumTokens > 0) {
    return {
      basis: 'tokens',
      totalValue: sumTokens,
      items: normalized.map((item) => {
        const value = Math.max(0, item.totalTokens);
        const share = value / sumTokens;
        return { ...item, value, share, percent: share * 100 };
      }),
    };
  }

  const sumTurns = normalized.reduce((acc, item) => acc + Math.max(0, item.turnCount), 0);
  if (sumTurns > 0) {
    return {
      basis: 'turns',
      totalValue: sumTurns,
      items: normalized.map((item) => {
        const value = Math.max(0, item.turnCount);
        const share = value / sumTurns;
        return { ...item, value, share, percent: share * 100 };
      }),
    };
  }

  const sumSessions = normalized.reduce((acc, item) => acc + Math.max(0, item.sessionCount), 0);
  if (sumSessions > 0) {
    return {
      basis: 'sessions',
      totalValue: sumSessions,
      items: normalized.map((item) => {
        const value = Math.max(0, item.sessionCount);
        const share = value / sumSessions;
        return { ...item, value, share, percent: share * 100 };
      }),
    };
  }

  return {
    basis: 'none',
    totalValue: 0,
    items: normalized.map((item) => ({ ...item, value: 0, share: 0, percent: 0 })),
  };
}

export function filterTopSessions(
  sessions: InsightsTopSession[],
  selectedProvider: CliProviderId | 'all',
): InsightsTopSession[] {
  if (selectedProvider === 'all') return sessions;
  return sessions.filter((session) => session.provider === selectedProvider);
}

export function getTelemetryCoveragePercent(tokenReportedRuns: number, totalRuns: number): number {
  if (!Number.isFinite(totalRuns) || totalRuns <= 0) return 0;
  const clamped = Math.max(0, Math.min(tokenReportedRuns, totalRuns));
  return Math.round((clamped / totalRuns) * 100);
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse motion-reduce:animate-none" aria-busy="true" aria-label="Loading insights">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index} className="gap-3 border-border/80 bg-card/75 p-4">
            <div className="h-3 w-24 rounded bg-muted" />
            <div className="h-7 w-28 rounded bg-muted" />
            <div className="h-3 w-full rounded bg-muted/70" />
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index} className="gap-3 border-border/80 bg-card/75 p-4">
            <div className="h-4 w-32 rounded bg-muted" />
            <div className="h-2 w-full rounded bg-muted/70" />
            <div className="h-10 w-full rounded bg-muted/60" />
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card className="h-52 border-border/80 bg-card/75 p-4 lg:col-span-5" />
        <Card className="h-52 border-border/80 bg-card/75 p-4 lg:col-span-7" />
      </div>
    </div>
  );
}

export function AnalyticsDashboard() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const [range, setRange] = useState<InsightsTimeRange>('7d');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<CliProviderId | 'all'>('all');
  const [data, setData] = useState<InsightsUsageResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  // Reset workspace scope if the selected workspace was removed.
  useEffect(() => {
    if (workspaceId && !workspaces.some((workspace) => workspace.id === workspaceId)) {
      setWorkspaceId(null);
    }
  }, [workspaceId, workspaces]);

  const loadUsage = useCallback(
    async (signal?: AbortSignal) => {
      const requestId = ++requestSeqRef.current;
      setLoading(true);
      setError(null);
      try {
        const response = await apiRequest<InsightsUsageResponse>(
          buildInsightsUsageUrl(range, workspaceId),
          { signal },
        );
        if (requestSeqRef.current !== requestId) return;
        setData(response);
      } catch (cause: unknown) {
        if (cause instanceof Error && cause.name === 'AbortError') return;
        if (requestSeqRef.current !== requestId) return;
        const message =
          cause instanceof Error && cause.message
            ? cause.message
            : 'Could not load usage insights from the local service.';
        setError(message);
      } finally {
        if (requestSeqRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [range, workspaceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadUsage(controller.signal);
    return () => controller.abort();
  }, [loadUsage]);

  const shares = useMemo(
    () => computeProviderShares(data?.byProvider ?? []),
    [data?.byProvider],
  );
  const modes = useMemo(
    () => normalizeModeBreakdowns(data?.byMode ?? []),
    [data?.byMode],
  );
  const dailyPoints = useMemo(
    () => [...(data?.daily ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [data?.daily],
  );
  const maxDailyTokens = useMemo(
    () => dailyPoints.reduce((max, point) => Math.max(max, point.totalTokens), 0),
    [dailyPoints],
  );
  const filteredSessions = useMemo(
    () => filterTopSessions(data?.topSessions ?? [], selectedProvider),
    [data?.topSessions, selectedProvider],
  );

  const totals = data?.totals;
  const cachedAndReasoning = (totals?.cachedTokens ?? 0) + (totals?.reasoningTokens ?? 0);
  const formattedCost = formatUsd(totals?.totalCostUsd);
  const coveragePercent = getTelemetryCoveragePercent(
    totals?.tokenReportedRuns ?? 0,
    totals?.totalRuns ?? 0,
  );
  const topShareProvider = shares.items.find((item) => item.value > 0) ?? null;

  const maxModeValue = useMemo(() => {
    const maxTokens = modes.reduce((max, mode) => Math.max(max, mode.totalTokens), 0);
    if (maxTokens > 0) return { basis: 'tokens' as const, max: maxTokens };
    const maxRuns = modes.reduce((max, mode) => Math.max(max, mode.runCount), 0);
    return { basis: 'runs' as const, max: maxRuns };
  }, [modes]);

  const isGlobalEmpty =
    Boolean(data) &&
    (totals?.totalRuns ?? 0) === 0 &&
    (data?.topSessions.length ?? 0) === 0 &&
    (totals?.totalTokens ?? 0) === 0;

  const handleSessionKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, session: InsightsTopSession) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void navigateToActivityTarget(session.target);
    }
  };

  return (
    <ScrollArea className="min-h-0 flex-1 bg-background">
      <main className="mx-auto w-full max-w-[1440px] space-y-5 p-5 pb-10">
        {/* Header Bar */}
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Insights</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Token usage, CLI distribution, and runtime activity across your projects.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Workspace scope"
              value={workspaceId ?? ''}
              onChange={(event) => setWorkspaceId(event.target.value || null)}
              className="h-8 max-w-[220px] rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">All projects</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>

            <div
              role="group"
              aria-label="Time range"
              className="inline-flex h-8 items-center rounded-md border border-border/80 bg-muted/60 p-0.5"
            >
              {TIME_RANGE_OPTIONS.map((option) => {
                const active = range === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setRange(option.value)}
                    className={cn(
                      'rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      active
                        ? 'bg-background text-foreground shadow-xs'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>

            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => void loadUsage()}
              disabled={loading}
              aria-label="Refresh insights"
              title="Refresh insights"
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', loading && 'animate-spin motion-reduce:animate-none')}
                aria-hidden="true"
              />
            </Button>
          </div>
        </header>

        {/* Inline Error Banner when stale data exists */}
        {error && data && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-xs text-destructive"
          >
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </span>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void loadUsage()}>
              Retry
            </Button>
          </div>
        )}

        {/* Loading / Blocking Error / Empty / Data */}
        {loading && !data ? (
          <LoadingSkeleton />
        ) : error && !data ? (
          <Card className="items-center gap-3 border-border/80 bg-card/75 px-6 py-14 text-center" role="alert">
            <AlertTriangle className="h-6 w-6 text-destructive" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-foreground">Unable to load Insights</p>
              <p className="mt-1 text-xs text-muted-foreground">{error}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void loadUsage()}>
              Retry
            </Button>
          </Card>
        ) : isGlobalEmpty ? (
          <Card className="items-center gap-3 border-border/80 bg-card/75 px-6 py-14 text-center">
            <Coins className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-foreground">No CLI activity in this window</p>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                Run a Manual terminal, Orchestrator mission, or Planning session to track token usage, CLI share, and runtime duration here.
              </p>
            </div>
            {(range !== 'all' || workspaceId !== null) && (
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                {range !== 'all' && (
                  <Button variant="outline" size="sm" onClick={() => setRange('all')}>
                    View all time
                  </Button>
                )}
                {workspaceId !== null && (
                  <Button variant="outline" size="sm" onClick={() => setWorkspaceId(null)}>
                    Show all projects
                  </Button>
                )}
              </div>
            )}
          </Card>
        ) : data ? (
          <>
            {/* Top KPI Row (4 balanced cards) */}
            <section aria-label="Key usage metrics" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {/* 1. Total Tokens */}
              <Card className="justify-between gap-2.5 border-border/80 bg-card/80 p-4 shadow-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Total Tokens
                  </span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {formatExactNumber(totals?.totalTokens)}
                  </span>
                </div>
                <p
                  className="text-2xl font-semibold tracking-tight tabular-nums text-foreground"
                  title={`${formatExactNumber(totals?.totalTokens)} total tokens`}
                >
                  {formatTokenCount(totals?.totalTokens)}
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  Input {formatTokenCount(totals?.inputTokens)} · Output {formatTokenCount(totals?.outputTokens)} · Cached / Thinking{' '}
                  {formatTokenCount(cachedAndReasoning)}
                </p>
              </Card>

              {/* 2. CLI Share */}
              <Card className="justify-between gap-2.5 border-border/80 bg-card/80 p-4 shadow-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    CLI Share
                  </span>
                  {shares.basis !== 'tokens' && shares.basis !== 'none' && (
                    <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">
                      by {shares.basis}
                    </Badge>
                  )}
                </div>

                {topShareProvider ? (
                  <div className="flex items-baseline gap-2">
                    <span className="inline-flex items-center gap-1.5 text-lg font-semibold tracking-tight text-foreground">
                      <RuntimeBrandIcon runtimeId={topShareProvider.provider} className="h-4 w-4 shrink-0" />
                      {topShareProvider.label}
                    </span>
                    <span className="text-sm font-medium tabular-nums text-muted-foreground">
                      {Math.round(topShareProvider.percent)}%
                    </span>
                  </div>
                ) : (
                  <p className="text-lg font-semibold text-muted-foreground">No CLI share yet</p>
                )}

                <div className="space-y-1.5">
                  <div
                    className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
                    role="img"
                    aria-label="CLI share distribution bar"
                  >
                    {shares.items
                      .filter((item) => item.percent > 0)
                      .map((item) => (
                        <div
                          key={item.provider}
                          style={{
                            width: `${item.percent}%`,
                            backgroundColor: PROVIDER_META[item.provider].color,
                          }}
                          className="h-full min-w-[3px] transition-all"
                          title={`${item.label}: ${Math.round(item.percent)}% (${
                            shares.basis === 'tokens'
                              ? `${formatExactNumber(item.value)} tokens`
                              : `${formatExactNumber(item.value)} ${shares.basis}`
                          })`}
                        />
                      ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
                    {shares.items
                      .filter((item) => item.value > 0)
                      .map((item) => (
                        <span key={item.provider} className="inline-flex items-center gap-1 tabular-nums">
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: PROVIDER_META[item.provider].color }}
                            aria-hidden="true"
                          />
                          {item.label} {Math.round(item.percent)}%
                        </span>
                      ))}
                  </div>
                </div>
              </Card>

              {/* 3. Total Runtime */}
              <Card className="justify-between gap-2.5 border-border/80 bg-card/80 p-4 shadow-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Total Runtime
                  </span>
                  <Clock3 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                </div>
                <p className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                  {formatDurationCompact(totals?.totalDurationMs)}
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {formatExactNumber(totals?.totalRuns)} {totals?.totalRuns === 1 ? 'run' : 'runs'}
                  {(totals?.totalRuns ?? 0) > 0 && (totals?.totalDurationMs ?? 0) > 0
                    ? ` · ~${formatDurationCompact(Math.round((totals?.totalDurationMs ?? 0) / (totals?.totalRuns ?? 1)))} avg`
                    : ''}
                </p>
              </Card>

              {/* 4. Telemetry Coverage & Cost */}
              <Card className="justify-between gap-2.5 border-border/80 bg-card/80 p-4 shadow-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Telemetry &amp; Cost
                  </span>
                  {formattedCost ? (
                    <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">
                      Reported spend
                    </Badge>
                  ) : (
                    <span className="text-[11px] tabular-nums text-muted-foreground">{coveragePercent}% coverage</span>
                  )}
                </div>
                <p className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                  {formattedCost ?? `${coveragePercent}%`}
                </p>
                <div className="space-y-1.5">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${coveragePercent}%` }}
                    />
                  </div>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {formatExactNumber(totals?.tokenReportedRuns)} of {formatExactNumber(totals?.totalRuns)} runs reported tokens
                  </p>
                </div>
              </Card>
            </section>

            {/* Usage by CLI Section */}
            <section aria-label="Usage by CLI" className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-foreground">Usage by CLI</h2>
                  <p className="text-xs text-muted-foreground">
                    Select a provider to filter the sessions table below.
                  </p>
                </div>
                {selectedProvider !== 'all' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() => setSelectedProvider('all')}
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                    Clear CLI filter
                  </Button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                {shares.items.map((item) => {
                  const meta = PROVIDER_META[item.provider];
                  const isSelected = selectedProvider === item.provider;
                  const turnsOnly = item.sessionCount > 0 && item.tokenReportingCount === 0;
                  const providerCost = formatUsd(item.totalCostUsd);
                  const cachedReasoning = item.cachedTokens + item.reasoningTokens;

                  return (
                    <button
                      key={item.provider}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() =>
                        setSelectedProvider((prev) => (prev === item.provider ? 'all' : item.provider))
                      }
                      className={cn(
                        'group flex flex-col justify-between gap-3 rounded-xl border bg-card/80 p-4 text-left shadow-xs transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isSelected
                          ? 'border-primary bg-primary/[0.04] ring-1 ring-primary/30'
                          : 'border-border/80 hover:border-border hover:bg-card',
                      )}
                    >
                      <div className="flex w-full items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={cn(
                              'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                              meta.tintBg,
                              meta.tintText,
                            )}
                          >
                            <RuntimeBrandIcon runtimeId={item.provider} className="h-4 w-4" />
                          </span>
                          <span className="truncate text-sm font-semibold text-foreground">
                            {item.label}
                          </span>
                        </div>

                        {turnsOnly ? (
                          <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px] font-medium">
                            Turns &amp; duration only
                          </Badge>
                        ) : (
                          <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                            {item.value > 0 ? `${Math.round(item.percent)}%` : '0%'}
                          </span>
                        )}
                      </div>

                      {/* Proportional share bar */}
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${item.percent}%`,
                            backgroundColor: meta.color,
                          }}
                        />
                      </div>

                      {/* Token metrics */}
                      <div className="grid w-full grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                        <div>
                          <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                            Total Tokens
                          </span>
                          <span
                            className="font-semibold tabular-nums text-foreground"
                            title={
                              turnsOnly
                                ? 'Token telemetry not reported by this CLI'
                                : `${formatExactNumber(item.totalTokens)} tokens`
                            }
                          >
                            {turnsOnly ? '—' : formatTokenCount(item.totalTokens)}
                          </span>
                        </div>
                        <div>
                          <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                            Input / Output
                          </span>
                          <span className="tabular-nums text-foreground">
                            {turnsOnly
                              ? '—'
                              : `${formatTokenCount(item.inputTokens)} / ${formatTokenCount(item.outputTokens)}`}
                          </span>
                        </div>
                        <div className="col-span-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                          <span>Cached / Reasoning</span>
                          <span className="tabular-nums text-foreground/90">
                            {turnsOnly ? '—' : formatTokenCount(cachedReasoning)}
                          </span>
                        </div>
                      </div>

                      {/* Sessions / Turns / Duration footer */}
                      <div className="flex w-full flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5 text-[11px] tabular-nums text-muted-foreground">
                        <span>
                          {formatExactNumber(item.sessionCount)} {item.sessionCount === 1 ? 'session' : 'sessions'} ·{' '}
                          {formatExactNumber(item.turnCount)} {item.turnCount === 1 ? 'turn' : 'turns'}
                        </span>
                        <span className="font-medium text-foreground/85">
                          {formatDurationCompact(item.totalDurationMs)}
                          {providerCost ? ` · ${providerCost}` : ''}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Workflow Mode Split + Daily Activity Trend */}
            <section className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              {/* By Mode */}
              <Card className="gap-0 overflow-hidden border-border/80 bg-card/80 py-0 shadow-xs lg:col-span-5">
                <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
                  <h2 className="text-sm font-semibold text-foreground">By Mode</h2>
                  <span className="text-[11px] text-muted-foreground">Manual · Orchestrator · Planning</span>
                </div>
                <div className="divide-y divide-border/60 px-4 py-1">
                  {modes.map((mode) => {
                    const meta = MODE_META[mode.mode];
                    const ModeIcon = meta.icon;
                    const metricValue = maxModeValue.basis === 'tokens' ? mode.totalTokens : mode.runCount;
                    const barWidth = maxModeValue.max > 0 ? Math.max(0, (metricValue / maxModeValue.max) * 100) : 0;

                    return (
                      <div key={mode.mode} className="space-y-2 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                            <ModeIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                            {meta.label}
                          </span>
                          <span
                            className="text-xs font-semibold tabular-nums text-foreground"
                            title={`${formatExactNumber(mode.totalTokens)} tokens`}
                          >
                            {formatTokenCount(mode.totalTokens)} tokens
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary/80 transition-all"
                            style={{ width: `${barWidth}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
                          <span>
                            {formatExactNumber(mode.runCount)} {mode.runCount === 1 ? 'run' : 'runs'}
                          </span>
                          <span>{formatDurationCompact(mode.totalDurationMs)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>

              {/* Daily Token Trend */}
              <Card className="gap-0 overflow-hidden border-border/80 bg-card/80 py-0 shadow-xs lg:col-span-7">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
                  <h2 className="text-sm font-semibold text-foreground">Daily Token Trend</h2>
                  <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                    {PROVIDER_ORDER.map((provider) => (
                      <span key={provider} className="inline-flex items-center gap-1">
                        <span
                          className="h-2 w-2 rounded-xs"
                          style={{ backgroundColor: PROVIDER_META[provider].color }}
                          aria-hidden="true"
                        />
                        {PROVIDER_META[provider].label}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="flex flex-1 flex-col justify-between p-4">
                  {dailyPoints.length === 0 || maxDailyTokens === 0 ? (
                    <div className="flex min-h-[168px] flex-col items-center justify-center text-center">
                      <p className="text-xs font-medium text-muted-foreground">
                        No daily token trend for this range.
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground/80">
                        Daily bars appear as CLI runs report token telemetry.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
                        <span>Peak: {formatTokenCount(maxDailyTokens)} tokens</span>
                        <span>{dailyPoints.length} {dailyPoints.length === 1 ? 'day' : 'days'}</span>
                      </div>

                      <div className="relative flex h-40 items-end gap-1 border-b border-border/70 pt-3">
                        {/* Horizontal guide lines */}
                        <div
                          className="pointer-events-none absolute inset-x-0 top-3 border-t border-dashed border-border/50"
                          aria-hidden="true"
                        />
                        <div
                          className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-border/40"
                          aria-hidden="true"
                        />

                        {dailyPoints.map((point) => {
                          const totalHeightPct = Math.max(
                            point.totalTokens > 0 ? 4 : 0,
                            (point.totalTokens / maxDailyTokens) * 100,
                          );
                          const providerEntries = PROVIDER_ORDER.map((provider) => ({
                            provider,
                            tokens: Math.max(0, point.byProvider[provider] ?? 0),
                          })).filter((entry) => entry.tokens > 0);
                          const providerSum = providerEntries.reduce((sum, entry) => sum + entry.tokens, 0);
                          const unattributed = Math.max(0, point.totalTokens - providerSum);

                          const breakdownTooltip = providerEntries
                            .map((entry) => `${PROVIDER_META[entry.provider].label}: ${formatTokenCount(entry.tokens)}`)
                            .join(' · ');
                          const dayTooltip = `${formatShortDay(point.date)} (${point.date}): ${formatExactNumber(
                            point.totalTokens,
                          )} tokens${breakdownTooltip ? `\n${breakdownTooltip}` : ''}`;

                          return (
                            <div
                              key={point.date}
                              title={dayTooltip}
                              className="group relative flex h-full min-w-0 flex-1 items-end justify-center"
                            >
                              <div
                                className="flex w-full max-w-[28px] flex-col-reverse overflow-hidden rounded-t-sm transition-opacity group-hover:opacity-85"
                                style={{ height: `${totalHeightPct}%` }}
                              >
                                {providerEntries.map((entry) => {
                                  const segPct = point.totalTokens > 0 ? (entry.tokens / point.totalTokens) * 100 : 0;
                                  return (
                                    <div
                                      key={entry.provider}
                                      style={{
                                        height: `${segPct}%`,
                                        backgroundColor: PROVIDER_META[entry.provider].color,
                                      }}
                                    />
                                  );
                                })}
                                {unattributed > 0 && point.totalTokens > 0 && (
                                  <div
                                    className="bg-muted-foreground/45"
                                    style={{ height: `${(unattributed / point.totalTokens) * 100}%` }}
                                  />
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* X-axis date ticks */}
                      <div className="flex items-center justify-between gap-2 text-[10px] tabular-nums text-muted-foreground">
                        <span>{formatShortDay(dailyPoints[0].date)}</span>
                        {dailyPoints.length > 2 && (
                          <span>{formatShortDay(dailyPoints[Math.floor(dailyPoints.length / 2)].date)}</span>
                        )}
                        {dailyPoints.length > 1 && (
                          <span>{formatShortDay(dailyPoints[dailyPoints.length - 1].date)}</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            </section>

            {/* Recent & Highest-Usage Sessions Table */}
            <Card className="gap-0 overflow-hidden border-border/80 bg-card/80 py-0 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-foreground">Recent &amp; Highest-Usage Sessions</h2>
                  <Badge variant="secondary" className="min-w-6 justify-center text-[10px] tabular-nums">
                    {filteredSessions.length}
                  </Badge>
                </div>

                {selectedProvider !== 'all' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 px-2.5 text-xs"
                    onClick={() => setSelectedProvider('all')}
                  >
                    <span>{PROVIDER_META[selectedProvider].label}</span>
                    <span className="text-muted-foreground">· Clear CLI filter</span>
                    <X className="h-3 w-3" aria-hidden="true" />
                  </Button>
                )}
              </div>

              {filteredSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                  <p className="text-xs font-medium text-muted-foreground">
                    {selectedProvider !== 'all'
                      ? `No sessions found for ${PROVIDER_META[selectedProvider].label} in this view.`
                      : 'No sessions recorded for this scope and time range.'}
                  </p>
                  {selectedProvider !== 'all' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setSelectedProvider('all')}
                    >
                      Clear CLI filter
                    </Button>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[660px] border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-border/60 bg-muted/30 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        <th className="px-4 py-2.5">Session</th>
                        <th className="px-3 py-2.5">Mode</th>
                        <th className="px-3 py-2.5 text-right">Input</th>
                        <th className="px-3 py-2.5 text-right">Output</th>
                        <th className="px-3 py-2.5 text-right">Total Tokens</th>
                        <th className="px-3 py-2.5 text-right">Duration</th>
                        <th className="px-4 py-2.5 text-right">When</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {filteredSessions.map((session) => {
                        const modeMeta = MODE_META[session.mode];
                        const providerMeta = session.provider === 'mixed' ? null : PROVIDER_META[session.provider];
                        const providerColor = providerMeta?.color;
                        const providerLabel = providerMeta?.label ?? 'Mixed CLIs';

                        return (
                          <tr
                            key={session.itemKey}
                            tabIndex={0}
                            role="button"
                            aria-label={`Open ${session.title || 'Untitled session'} in ${session.workspaceName}`}
                            onClick={() => void navigateToActivityTarget(session.target)}
                            onKeyDown={(event) => handleSessionKeyDown(event, session)}
                            className="cursor-pointer transition-colors hover:bg-muted/40 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          >
                            <td className="max-w-[320px] px-4 py-2.5">
                              <div className="flex items-center gap-2.5">
                                <span
                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/70 text-foreground"
                                  style={providerColor ? { color: providerColor } : undefined}
                                  title={providerLabel}
                                >
                                  {session.provider === 'mixed' ? (
                                    <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                                  ) : (
                                    <RuntimeBrandIcon
                                      runtimeId={session.provider}
                                      className="h-3.5 w-3.5"
                                    />
                                  )}
                                </span>
                                <div className="min-w-0">
                                  <p className="truncate font-medium text-foreground">
                                    {session.title || 'Untitled session'}
                                  </p>
                                  <p className="truncate text-[11px] text-muted-foreground">
                                    {session.workspaceName}
                                    {session.model ? ` · ${session.model}` : ''}
                                    {!session.usageAvailable && session.turnCount > 0
                                      ? ` · ${session.turnCount} ${session.turnCount === 1 ? 'turn' : 'turns'}`
                                      : ''}
                                  </p>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <Badge variant="outline" className="text-[10px] font-medium">
                                {modeMeta.label}
                              </Badge>
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                              {session.usageAvailable ? formatTokenCount(session.inputTokens) : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                              {session.usageAvailable ? formatTokenCount(session.outputTokens) : '—'}
                            </td>
                            <td
                              className="px-3 py-2.5 text-right font-semibold tabular-nums text-foreground"
                              title={
                                session.usageAvailable
                                  ? `${formatExactNumber(session.totalTokens)} tokens`
                                  : 'Token telemetry unavailable for this session'
                              }
                            >
                              {session.usageAvailable ? formatTokenCount(session.totalTokens) : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                              {formatDurationCompact(session.durationMs)}
                            </td>
                            <td
                              className="px-4 py-2.5 text-right whitespace-nowrap tabular-nums text-muted-foreground"
                              title={session.recordedAt}
                            >
                              {formatRelativeWhen(session.recordedAt)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        ) : null}
      </main>
    </ScrollArea>
  );
}
