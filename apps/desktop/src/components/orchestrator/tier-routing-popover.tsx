import { useEffect, useMemo, useState } from 'react';
import type { CanonicalReasoning, RuntimeAdapterCapabilities, RuntimeType } from '@atris-agent-code/domain';
import { Check, ChevronDown, ChevronRight, Loader2, ShieldCheck, SlidersHorizontal, Sparkles, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { RuntimeBrandIcon, RUNTIME_BRANDS } from '@/components/runtime/runtime-brand-icon';
import { TeamTemplateSelector } from '@/components/composer/team-template-selector';
import { AgentProfileSelector } from '@/components/composer/agent-profile-selector';
import { apiRequest } from '@/lib/api-client';
import { useAccountStore } from '@/stores/account-store';
import { useOrchestratorPreferences } from '@/stores/orchestrator-preferences-store';
import { useSettingsStore } from '@/stores/settings-store';
import { cn } from '@/lib/utils';

export interface TierRouteDefault {
  modelCatalogId?: string;
  reasoningLevel?: CanonicalReasoning;
  fallbackCatalogIds?: string[];
}

export interface OrchestratorRoutingDefaults {
  worker?: TierRouteDefault;
  review?: TierRouteDefault;
}

const SHORT_LABELS: Record<RuntimeType, string> = {
  codex: 'Codex',
  claude_code: 'Claude Code',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
};

export function TierRoutingPopover({
  capabilitiesOverride,
}: {
  capabilitiesOverride?: Partial<Record<string, RuntimeAdapterCapabilities>>;
}) {
  const { preferences, updatePreferences } = useOrchestratorPreferences();
  const { accounts, runtimes, discoveredModels } = useAccountStore();
  const [open, setOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [defaults, setDefaults] = useState<OrchestratorRoutingDefaults>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void apiRequest<OrchestratorRoutingDefaults>('/orchestrator/routing-defaults')
      .then((data) => {
        if (!cancelled) setDefaults(data || {});
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Failed to load routing defaults.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open]);

  const availableModels = useMemo(
    () => discoveredModels.filter((model) => model.available),
    [discoveredModels],
  );

  const selectedSpecialists = Object.values(preferences.agentProfileIds).filter(Boolean).length;
  const hasTierOverrides = Boolean(defaults.worker?.modelCatalogId || defaults.review?.modelCatalogId);
  const connectedCount = useMemo(
    () => RUNTIME_BRANDS.filter((brand) =>
      accounts.some((account) => account.runtimeType === brand.id && account.authStatus === 'connected'),
    ).length,
    [accounts],
  );

  const persistDefaults = async (next: OrchestratorRoutingDefaults) => {
    setDefaults(next);
    setSaving(true);
    setSavedNotice(false);
    setError(null);
    try {
      const saved = await apiRequest<OrchestratorRoutingDefaults>('/orchestrator/routing-defaults', {
        method: 'PUT',
        body: JSON.stringify(next),
      });
      setDefaults(saved || {});
      setSavedNotice(true);
      window.setTimeout(() => setSavedNotice(false), 1800);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save routing defaults.');
    } finally {
      setSaving(false);
    }
  };

  const updateTier = (tier: 'worker' | 'review', modelCatalogId: string) => {
    const model = availableModels.find((item) => item.catalogId === modelCatalogId);
    const nextTier: TierRouteDefault | undefined = modelCatalogId
      ? {
          modelCatalogId,
          ...(model?.defaultReasoning ? { reasoningLevel: model.defaultReasoning } : {}),
        }
      : undefined;
    const next: OrchestratorRoutingDefaults = {
      ...defaults,
      ...(nextTier ? { [tier]: nextTier } : {}),
    };
    if (!nextTier) delete next[tier];
    void persistDefaults(next);
  };

  const updateTierReasoning = (tier: 'worker' | 'review', reasoningLevel: CanonicalReasoning) => {
    const current = defaults[tier];
    if (!current?.modelCatalogId) return;
    void persistDefaults({
      ...defaults,
      [tier]: { ...current, reasoningLevel },
    });
  };

  const renderTierControl = (
    tier: 'worker' | 'review',
    label: string,
    hint: string,
  ) => {
    const current = defaults[tier];
    const selectedModel = availableModels.find((item) => item.catalogId === current?.modelCatalogId);
    return (
      <div className="space-y-1.5 rounded-lg border border-border/70 bg-muted/20 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">{label}</span>
          <span className="text-[10px] text-muted-foreground">{hint}</span>
        </div>
        <select
          aria-label={label}
          value={current?.modelCatalogId || ''}
          disabled={loading || saving}
          onChange={(event) => updateTier(tier, event.target.value)}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">Auto (zero-config scheduler)</option>
          {availableModels.map((model) => (
            <option key={model.catalogId} value={model.catalogId}>
              {SHORT_LABELS[model.runtimeType] || model.runtimeType} · {model.name}
            </option>
          ))}
        </select>
        {selectedModel && selectedModel.supportedReasoning.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 pt-0.5">
            <span className="mr-1 text-[10px] text-muted-foreground">Reasoning:</span>
            {selectedModel.supportedReasoning.map((level) => (
              <button
                key={level}
                type="button"
                disabled={saving}
                onClick={() => updateTierReasoning(tier, level)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] transition-colors',
                  (current?.reasoningLevel || selectedModel.defaultReasoning) === level
                    ? 'bg-primary/15 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {level === 'xhigh' ? 'x-high' : level}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Tier routing and CLI health"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span>
            Routing: {hasTierOverrides ? 'Custom' : selectedSpecialists ? `${selectedSpecialists} specialists` : 'Auto'}
          </span>
          {connectedCount > 0 && (
            <span className="rounded-full bg-emerald-500/15 px-1.5 py-0 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
              {connectedCount} CLI
            </span>
          )}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="w-[min(400px,calc(100vw-2rem))] space-y-3 p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-xs font-semibold text-foreground">Local CLIs &amp; Tier Routing</h3>
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
              Connected CLIs are zero-config ready across all roles. Optionally pin tier defaults below.
            </p>
          </div>
          {(loading || saving) && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
          {savedNotice && !saving && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
              <Check className="h-3 w-3" />Saved
            </span>
          )}
        </div>

        {/* Connected local CLI health pills */}
        <div className="flex flex-wrap gap-1.5" aria-label="Connected local CLIs">
          {RUNTIME_BRANDS.map((brand) => {
            const runtimeStatus = runtimes.find((item) => item.runtimeType === brand.id);
            const connected = accounts.some(
              (account) => account.runtimeType === brand.id && account.authStatus === 'connected',
            );
            const installed = runtimeStatus?.installation.installed ?? connected;
            const caps = capabilitiesOverride?.[brand.id] ?? runtimeStatus?.adapterCapabilities;
            return (
              <div
                key={brand.id}
                title={[
                  SHORT_LABELS[brand.id],
                  connected ? 'Connected & zero-config ready' : installed ? 'Installed (needs auth)' : 'Not detected',
                  caps?.liveSteer ? 'Live Steer supported' : 'Queued directives',
                  caps?.interactiveApproval ? 'Interactive approvals' : undefined,
                ].filter(Boolean).join(' · ')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px]',
                  connected
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-foreground'
                    : 'border-border/70 bg-muted/30 text-muted-foreground',
                )}
              >
                <RuntimeBrandIcon runtimeId={brand.id} className="h-3 w-3 shrink-0" />
                <span className="font-medium">{SHORT_LABELS[brand.id]}</span>
                {connected && (
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-label="Ready" />
                )}
                {connected && caps?.liveSteer && (
                  <Zap className="h-2.5 w-2.5 text-amber-400" aria-label="Live Steer" />
                )}
                {connected && caps?.interactiveApproval && (
                  <ShieldCheck className="h-2.5 w-2.5 text-primary" aria-label="Approvals" />
                )}
              </div>
            );
          })}
        </div>

        {/* 2 Simple Tier Defaults */}
        <div className="space-y-2">
          {renderTierControl('worker', 'Worker Tier', 'Inspect & implement')}
          {renderTierControl('review', 'Deep / Review Tier', 'Verify & review')}
        </div>

        {error && (
          <p role="alert" className="text-[11px] text-destructive">{error}</p>
        )}

        {/* Collapsible Advanced Overrides */}
        <div className="border-t border-border/70 pt-2">
          <button
            type="button"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            className="flex w-full items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('h-3 w-3 transition-transform', advancedOpen && 'rotate-90')} />
            <Sparkles className="h-3 w-3 text-primary/70" />
            <span>Advanced overrides (templates &amp; specialists)</span>
          </button>
          {advancedOpen && (
            <div className="mt-2.5 space-y-2.5 rounded-lg border border-border/60 bg-muted/15 p-2.5">
              <div className="flex flex-wrap gap-2">
                <TeamTemplateSelector />
                <AgentProfileSelector />
              </div>
              <label className="block text-[11px] font-medium text-foreground">
                Team launch
                <select
                  aria-label="Conversation team launch"
                  value={preferences.teamLaunch}
                  onChange={(event) => updatePreferences({ teamLaunch: event.target.value as 'automatic' | 'confirm' })}
                  className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="automatic">Choose and launch automatically</option>
                  <option value="confirm">Show team plan before launching</option>
                </select>
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 w-full text-xs"
                onClick={() => {
                  setOpen(false);
                  useSettingsStore.getState().setActiveView('agents');
                }}
              >
                Manage teams &amp; specialists
              </Button>
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
