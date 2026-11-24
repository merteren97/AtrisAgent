import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import type {
  ProviderUsageLimit,
  QuotaProviderId,
  QuotaWindow,
  UsageLimitsResponse,
  UsageLimitStatus,
} from '@/lib/activity-types';
import { apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

const QUOTA_PROVIDER_ORDER: readonly QuotaProviderId[] = ['antigravity', 'codex', 'claude_code'];
const REFRESH_INTERVAL_MS = 60_000;

const QUOTA_PROVIDER_META: Record<
  QuotaProviderId,
  { label: string; tintBg: string; tintText: string }
> = {
  antigravity: {
    label: 'Antigravity',
    tintBg: 'bg-indigo-500/12',
    tintText: 'text-indigo-600 dark:text-indigo-400',
  },
  codex: {
    label: 'Codex',
    tintBg: 'bg-emerald-500/12',
    tintText: 'text-emerald-600 dark:text-emerald-400',
  },
  claude_code: {
    label: 'Claude Code',
    tintBg: 'bg-[#d97757]/12',
    tintText: 'text-[#d97757]',
  },
};

export type QuotaTone = 'healthy' | 'warning' | 'critical';

export interface GroupedQuotaWindows {
  group: string | null;
  description?: string;
  windows: QuotaWindow[];
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function formatResetCountdown(resetsAt: string | null, nowMs = Date.now()): string {
  if (!resetsAt) return '';
  const targetMs = Date.parse(resetsAt);
  if (!Number.isFinite(targetMs)) return '';

  const diffMs = targetMs - nowMs;
  if (diffMs < 60_000) return 'Resetting soon';

  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `Resets in ${days}d ${hours}h` : `Resets in ${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `Resets in ${hours}h ${minutes}m` : `Resets in ${hours}h`;
  }
  return `Resets in ${minutes}m`;
}

export function getQuotaTone(remainingPercent: number): QuotaTone {
  const remaining = clampPercent(remainingPercent);
  if (remaining <= 10) return 'critical';
  if (remaining <= 25) return 'warning';
  return 'healthy';
}

export function groupQuotaWindows(windows: QuotaWindow[]): GroupedQuotaWindows[] {
  const groups = new Map<string | null, GroupedQuotaWindows>();

  for (const win of windows) {
    const key = win.group?.trim() ? win.group.trim() : null;
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        group: key,
        ...(win.groupDescription ? { description: win.groupDescription } : {}),
        windows: [],
      };
      groups.set(key, entry);
    } else if (!entry.description && win.groupDescription) {
      entry.description = win.groupDescription;
    }
    entry.windows.push(win);
  }

  return Array.from(groups.values());
}

function formatUpdatedAgo(isoString: string | undefined): string {
  if (!isoString) return '';
  const parsed = Date.parse(isoString);
  if (!Number.isFinite(parsed)) return '';
  const diffMs = Math.max(0, Date.now() - parsed);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours}h ago`;
}

function getStatusBadge(provider: ProviderUsageLimit): {
  label: string;
  variant: 'secondary' | 'warning' | 'destructive';
} | null {
  if (provider.status === 'ok') {
    if (provider.stale) {
      return { label: 'Stale', variant: 'warning' };
    }
    if (provider.planLabel) {
      return { label: provider.planLabel, variant: 'secondary' };
    }
    return null;
  }

  const labels: Record<Exclude<UsageLimitStatus, 'ok'>, { label: string; variant: 'secondary' | 'warning' | 'destructive' }> = {
    unauthenticated: { label: 'Not connected', variant: 'secondary' },
    unavailable: { label: 'Unavailable', variant: 'secondary' },
    rate_limited: { label: 'Rate limited', variant: 'warning' },
    error: { label: 'Error', variant: 'destructive' },
  };
  return labels[provider.status];
}

function getEmptyStateClasses(status: Exclude<UsageLimitStatus, 'ok'>): string {
  if (status === 'rate_limited') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  }
  if (status === 'error') {
    return 'border-destructive/30 bg-destructive/5 text-destructive';
  }
  return 'border-border/60 bg-muted/35 text-muted-foreground';
}

function getToneClasses(tone: QuotaTone): { text: string; bar: string } {
  if (tone === 'critical') {
    return {
      text: 'text-destructive',
      bar: 'bg-destructive',
    };
  }
  if (tone === 'warning') {
    return {
      text: 'text-amber-600 dark:text-amber-400',
      bar: 'bg-amber-500',
    };
  }
  return {
    text: 'text-emerald-600 dark:text-emerald-400',
    bar: 'bg-emerald-500',
  };
}

function UsageLimitsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 animate-pulse motion-reduce:animate-none" aria-busy="true" aria-label="Loading plan usage limits">
      {Array.from({ length: 3 }).map((_, index) => (
        <Card key={index} className="gap-3 border-border/80 bg-card/75 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-muted" />
              <div className="h-4 w-24 rounded bg-muted" />
            </div>
            <div className="h-5 w-16 rounded-md bg-muted" />
          </div>
          <div className="space-y-2.5">
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <div className="h-3 w-20 rounded bg-muted" />
                <div className="h-3 w-14 rounded bg-muted" />
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted/70" />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <div className="h-3 w-20 rounded bg-muted" />
                <div className="h-3 w-14 rounded bg-muted" />
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted/70" />
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

export function UsageLimitsSection() {
  const [data, setData] = useState<UsageLimitsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef<boolean>(true);
  const requestSeqRef = useRef<number>(0);

  const loadLimits = useCallback(async (options?: { refresh?: boolean; signal?: AbortSignal }) => {
    const requestId = ++requestSeqRef.current;
    if (options?.refresh) {
      setRefreshing(true);
    }
    setError(null);

    try {
      const endpoint = options?.refresh ? '/insights/usage-limits?refresh=1' : '/insights/usage-limits';
      const response = await apiRequest<UsageLimitsResponse>(endpoint, { signal: options?.signal });
      if (!mountedRef.current || requestSeqRef.current !== requestId) return;
      setData(response);
    } catch (cause: unknown) {
      if (cause instanceof Error && cause.name === 'AbortError') return;
      if (!mountedRef.current || requestSeqRef.current !== requestId) return;
      const message =
        cause instanceof Error && cause.message
          ? cause.message
          : 'Could not load plan usage limits.';
      setError(message);
    } finally {
      if (mountedRef.current && requestSeqRef.current === requestId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const initialController = new AbortController();
    let intervalController: AbortController | null = null;

    void loadLimits({ signal: initialController.signal });

    const timerId = window.setInterval(() => {
      intervalController?.abort();
      intervalController = new AbortController();
      void loadLimits({ signal: intervalController.signal });
    }, REFRESH_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      initialController.abort();
      intervalController?.abort();
      window.clearInterval(timerId);
    };
  }, [loadLimits]);

  const providersById = new Map<QuotaProviderId, ProviderUsageLimit>();
  for (const item of data?.providers ?? []) {
    providersById.set(item.provider, item);
  }

  const orderedProviders: ProviderUsageLimit[] = QUOTA_PROVIDER_ORDER.map((providerId) => {
    const existing = providersById.get(providerId);
    if (existing) return existing;
    return {
      provider: providerId,
      label: QUOTA_PROVIDER_META[providerId].label,
      status: 'unavailable',
      windows: [],
      message: 'Quota information unavailable.',
      fetchedAt: data?.generatedAt ?? new Date().toISOString(),
    };
  });

  const updatedLabel = formatUpdatedAgo(data?.generatedAt);

  return (
    <section aria-label="Plan Usage Limits" className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Plan Usage Limits</h2>
          <p className="text-xs text-muted-foreground">
            Remaining 5-hour and weekly quota across connected CLIs.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {data?.cached && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">
              Cached
            </Badge>
          )}
          {updatedLabel && (
            <span className="text-[11px] tabular-nums text-muted-foreground" title={data?.generatedAt}>
              {updatedLabel}
            </span>
          )}
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={() => void loadLimits({ refresh: true })}
            disabled={loading || refreshing}
            aria-label="Refresh plan usage limits"
            title="Refresh plan usage limits"
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', (loading || refreshing) && 'animate-spin motion-reduce:animate-none')}
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>

      {error && data && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-xs text-destructive"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void loadLimits({ refresh: true })}
            disabled={loading || refreshing}
          >
            Retry
          </Button>
        </div>
      )}

      {loading && !data ? (
        <UsageLimitsSkeleton />
      ) : error && !data ? (
        <Card className="flex-row items-center justify-between gap-3 border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive" role="alert">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </span>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void loadLimits({ refresh: true })}>
            Retry
          </Button>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {orderedProviders.map((provider) => {
              const meta = QUOTA_PROVIDER_META[provider.provider];
              const badge = getStatusBadge(provider);
              const grouped = groupQuotaWindows(provider.windows);

              return (
                <Card
                  key={provider.provider}
                  className="justify-between gap-3 border-border/80 bg-card/80 p-4 shadow-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                          meta.tintBg,
                          meta.tintText,
                        )}
                      >
                        <RuntimeBrandIcon runtimeId={provider.provider} className="h-4 w-4" />
                      </span>
                      <span className="truncate text-sm font-semibold text-foreground">
                        {provider.label || meta.label}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {provider.status === 'ok' && provider.stale && provider.planLabel && (
                        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">
                          {provider.planLabel}
                        </Badge>
                      )}
                      {badge && (
                        <Badge variant={badge.variant} className="px-1.5 py-0 text-[10px] font-medium">
                          {badge.label}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {provider.status === 'ok' && provider.windows.length > 0 ? (
                    <div className="space-y-3">
                      {grouped.map((group) => (
                        <div key={group.group ?? '__default'} className="space-y-2">
                          {group.group && (
                            <p
                              className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                              title={group.description}
                            >
                              {group.group}
                            </p>
                          )}

                          <div className="space-y-2.5">
                            {group.windows.map((win) => {
                              const remaining = clampPercent(win.remainingPercent);
                              const used = clampPercent(win.usedPercent);
                              const tone = getToneClasses(getQuotaTone(remaining));
                              const resetText = formatResetCountdown(win.resetsAt);
                              const resetTitle = win.resetsAt
                                ? new Date(win.resetsAt).toLocaleString()
                                : undefined;

                              return (
                                <div key={win.id} className="space-y-1">
                                  <div className="flex items-baseline justify-between gap-2">
                                    <span className="truncate text-xs font-medium text-foreground" title={win.description ?? undefined}>
                                      {win.label}
                                    </span>
                                    <span className={cn('shrink-0 text-xs font-semibold tabular-nums', tone.text)}>
                                      {Math.round(remaining)}% left
                                    </span>
                                  </div>

                                  <div
                                    className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                                    title={`${Math.round(remaining)}% remaining · ${Math.round(used)}% used`}
                                  >
                                    <div
                                      className={cn('h-full rounded-full transition-all', tone.bar)}
                                      style={{ width: `${remaining}%` }}
                                    />
                                  </div>

                                  <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
                                    <span>{Math.round(used)}% used</span>
                                    {resetText && (
                                      <span title={resetTitle}>{resetText}</span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div
                      className={cn(
                        'rounded-lg border px-3 py-3 text-xs leading-relaxed',
                        provider.status === 'ok'
                          ? 'border-border/60 bg-muted/35 text-muted-foreground'
                          : getEmptyStateClasses(provider.status),
                      )}
                    >
                      {provider.message || 'Not connected · Sign in via CLI to view quota limits.'}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-sky-500/12 text-sky-600 dark:text-sky-400">
              <RuntimeBrandIcon runtimeId="opencode" className="h-3.5 w-3.5" />
            </span>
            <span>
              {data?.opencodeNote || 'OpenCode uses provider API keys and has no 5-hour or weekly plan limits.'}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
