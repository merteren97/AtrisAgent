import { useEffect, useState } from 'react';
import { Activity, Coins, RefreshCw } from 'lucide-react';
import { useMissionStore } from '@/stores/mission-store';
import { apiRequest } from '@/lib/api-client';

interface MissionUsage {
  available: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number | null;
  currency: string | null;
  snapshotCount: number;
  lastRecordedAt: string | null;
}

export function UsageMeter() {
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const [usage, setUsage] = useState<MissionUsage | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!activeMissionId) {
      setUsage(null);
      return;
    }

    const load = async () => {
      setLoading(true);
      try {
        const response = await apiRequest<MissionUsage>(`/missions/${activeMissionId}/usage`);
        if (!cancelled) setUsage(response);
      } catch {
        if (!cancelled) setUsage(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeMissionId]);

  if (!activeMissionId) return null;

  if (!usage?.available) {
    return (
      <div
        className="flex select-none items-center gap-1.5 rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-[10px] text-muted-foreground shadow-sm"
        title="The selected CLI has not emitted a real usage snapshot for this mission. AtrisAgent does not estimate token or cost data."
      >
        {loading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Activity className="h-3.5 w-3.5 text-primary" />}
        <span>Usage unavailable</span>
      </div>
    );
  }

  return (
    <div className="flex select-none items-center gap-3 rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-[10px] text-muted-foreground shadow-sm">
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <Activity className="h-3.5 w-3.5 text-primary" />
        <span>{formatTokens(usage.totalTokens)} tokens</span>
      </div>
      <span>{formatTokens(usage.inputTokens)} in / {formatTokens(usage.outputTokens)} out</span>
      {usage.totalCost !== null && usage.currency && (
        <>
          <div className="h-3 w-px bg-border" />
          <div className="flex items-center gap-1 text-emerald-400">
            <Coins className="h-3 w-3" />
            <span className="font-medium">{formatCost(usage.totalCost, usage.currency)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function formatTokens(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
}

function formatCost(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 4 }).format(value);
  } catch {
    return `${value.toFixed(4)} ${currency}`;
  }
}
