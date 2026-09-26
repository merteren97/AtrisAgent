import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  AccountProfile,
  AgentRole,
  CanonicalReasoning,
  RoleExecutionPolicy,
  RouteSelectionMode,
  RuntimeType,
  TeamRole,
  TeamTemplate,
} from '@atris-agent-code/domain';
import { AlertCircle, CheckCircle2, ChevronDown, Loader2, Plus, RefreshCw, Route, Save, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RuntimeBrandIcon, RUNTIME_BRANDS } from '@/components/runtime/runtime-brand-icon';
import { apiRequest } from '@/lib/api-client';
import { useAccountStore, type DiscoveredModel } from '@/stores/account-store';
import { useSettingsStore } from '@/stores/settings-store';
import { normalizeTeamTemplates, reconcileTeamTemplateId } from '@/lib/team-template-utils';

const REASONING_LEVELS: CanonicalReasoning[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const SELECT_CLASS = 'h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-none focus:border-primary';
const MODES: Array<{ id: RouteSelectionMode; label: string; description: string }> = [
  { id: 'auto', label: 'Auto', description: 'The scheduler selects the best compatible live route for this role.' },
  { id: 'prefer', label: 'Prefer', description: 'Prefer the configured account/model route, then continue with ordered fallbacks and other compatible routes.' },
  { id: 'fixed', label: 'Fixed', description: 'Restrict this role to the configured primary route and explicitly ordered fallback routes.' },
];

type PolicyDraft = Partial<Record<AgentRole, RoleExecutionPolicy>>;
type RuntimeFilter = 'all' | RuntimeType;
type SavePolicyResponse = { success: boolean; policies: RoleExecutionPolicy[] };
type CatalogRefreshState = {
  status: 'idle' | 'refreshing' | 'success' | 'error';
  message?: string;
};

function roleLabel(role: AgentRole): string {
  if (role === 'qa') return 'QA';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function policyFromTemplateRole(role: TeamRole): RoleExecutionPolicy {
  const modelCatalogId = role.modelCatalogId || role.modelProfileId || undefined;
  return {
    role: role.role,
    selectionMode: role.routeSelectionMode || (modelCatalogId ? 'prefer' : 'auto'),
    modelCatalogId,
    accountProfileId: role.accountProfileId || undefined,
    reasoningLevel: role.preferredReasoning,
    fallbackCatalogIds: role.fallbackCatalogIds || [],
  };
}

function draftFrom(template: TeamTemplate, persisted: RoleExecutionPolicy[]): PolicyDraft {
  const byRole = new Map(persisted.map((policy) => [policy.role, policy]));
  return Object.fromEntries(template.roles.map((role) => [
    role.role,
    byRole.get(role.role) || policyFromTemplateRole(role),
  ])) as PolicyDraft;
}

function normalizePolicy(policy: RoleExecutionPolicy): RoleExecutionPolicy {
  const modelCatalogId = policy.modelCatalogId || undefined;
  return {
    role: policy.role,
    selectionMode: policy.selectionMode || 'auto',
    modelCatalogId,
    accountProfileId: policy.accountProfileId || undefined,
    reasoningLevel: policy.reasoningLevel || undefined,
    fallbackCatalogIds: Array.from(new Set(policy.fallbackCatalogIds || []))
      .filter((catalogId) => catalogId && catalogId !== modelCatalogId),
  };
}

function isRoleCompatible(model: DiscoveredModel, role: AgentRole): boolean {
  return model.suitableRoles.some((value) => value.toLowerCase() === role.toLowerCase());
}

export function ExecutionPolicyEditor() {
  const activeTemplateId = useSettingsStore((state) => state.teamTemplate);
  const setTeamTemplate = useSettingsStore((state) => state.setTeamTemplate);
  const accounts = useAccountStore((state) => state.accounts);
  const models = useAccountStore((state) => state.discoveredModels);
  const fetchAccounts = useAccountStore((state) => state.fetchAccounts);
  const refreshModels = useAccountStore((state) => state.refreshModels);

  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [templateId, setTemplateId] = useState(activeTemplateId);
  const [draft, setDraft] = useState<PolicyDraft>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogRefresh, setCatalogRefresh] = useState<CatalogRefreshState>({ status: 'idle' });

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === templateId),
    [templates, templateId],
  );

  useEffect(() => {
    let cancelled = false;
    void apiRequest<TeamTemplate[]>('/team-templates')
      .then((items) => {
        if (cancelled) return;
        const normalized = normalizeTeamTemplates(items);
        setTemplates(normalized);
        const reconciledId = reconcileTeamTemplateId(items, activeTemplateId);
        setTemplateId(reconciledId);
        if (reconciledId !== activeTemplateId) setTeamTemplate(reconciledId);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Team templates could not be loaded.');
      });
    return () => { cancelled = true; };
  }, [activeTemplateId, setTeamTemplate]);

  useEffect(() => {
    if (!accounts.length || !models.length) void fetchAccounts();
  }, [accounts.length, fetchAccounts, models.length]);

  useEffect(() => {
    if (!selectedTemplate) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaved(false);
    void apiRequest<RoleExecutionPolicy[]>(`/execution-policies/team_template/${encodeURIComponent(selectedTemplate.id)}`)
      .then((policies) => {
        if (!cancelled) setDraft(draftFrom(selectedTemplate, policies));
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Execution policy could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedTemplate]);

  const patchRole = (role: AgentRole, patch: Partial<RoleExecutionPolicy>) => {
    setSaved(false);
    setDraft((current) => {
      const existing = current[role] || { role, selectionMode: 'auto', fallbackCatalogIds: [] };
      return { ...current, [role]: normalizePolicy({ ...existing, ...patch, role }) };
    });
  };

  const save = async (nextDraft: PolicyDraft = draft) => {
    if (!selectedTemplate) return;
    const invalidFixedRole = selectedTemplate.roles.find((item) => {
      const policy = nextDraft[item.role] || policyFromTemplateRole(item);
      return policy.selectionMode === 'fixed' && !policy.modelCatalogId && !policy.accountProfileId && !policy.fallbackCatalogIds?.length;
    });
    if (invalidFixedRole) {
      setError(`${roleLabel(invalidFixedRole.role)} is Fixed but has no model, account, or fallback. Configure a route before saving.`);
      return;
    }
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      let persisted: RoleExecutionPolicy[] = [];
      for (const roleDefinition of selectedTemplate.roles) {
        const policy = normalizePolicy(nextDraft[roleDefinition.role] || policyFromTemplateRole(roleDefinition));
        const response = await apiRequest<SavePolicyResponse>(
          `/execution-policies/team_template/${encodeURIComponent(selectedTemplate.id)}/${encodeURIComponent(roleDefinition.role)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              modelCatalogId: policy.modelCatalogId,
              accountProfileId: policy.accountProfileId,
              reasoningLevel: policy.reasoningLevel,
              fallbackCatalogIds: policy.fallbackCatalogIds,
              selectionMode: policy.selectionMode,
            }),
          },
        );
        persisted = response.policies;
      }
      setDraft(draftFrom(selectedTemplate, persisted));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Execution policy could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const setAllSubagentsToAuto = () => {
    if (!selectedTemplate || saving) return;
    const nextDraft: PolicyDraft = { ...draft };
    for (const roleDefinition of selectedTemplate.roles) {
      if (roleDefinition.role === 'orchestrator') continue;
      nextDraft[roleDefinition.role] = normalizePolicy({
        role: roleDefinition.role,
        selectionMode: 'auto',
        fallbackCatalogIds: [],
      });
    }
    setDraft(nextDraft);
    void save(nextDraft);
  };

  const refreshCatalog = async () => {
    if (catalogRefresh.status === 'refreshing') return;
    setCatalogRefresh({ status: 'refreshing' });
    try {
      await refreshModels();
      setCatalogRefresh({ status: 'success', message: 'Catalog refreshed successfully.' });
    } catch (cause) {
      setCatalogRefresh({
        status: 'error',
        message: cause instanceof Error ? cause.message : 'Model catalog refresh failed.',
      });
    }
  };

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><Route className="h-4 w-4 text-primary" /> Team execution routing</CardTitle>
            <CardDescription className="mt-1 max-w-2xl">Use task-based automatic routing for subagents, or open a role to pin a model, reasoning level and ordered fallbacks. Fixed routes never silently switch to unlisted models.</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Team template for execution policy" value={templateId} onChange={(event) => setTemplateId(event.target.value)} className="h-9 min-w-48 rounded-md border border-input bg-background px-3 text-xs">
              {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
            </select>
            <Button variant="outline" size="sm" onClick={() => void refreshCatalog()} disabled={catalogRefresh.status === 'refreshing'} aria-busy={catalogRefresh.status === 'refreshing'}>
              {catalogRefresh.status === 'refreshing' ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
              {catalogRefresh.status === 'refreshing' ? 'Refreshing…' : 'Refresh catalog'}
            </Button>
            <Button variant="outline" size="sm" onClick={setAllSubagentsToAuto} disabled={!selectedTemplate || loading || saving}>
              {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Route className="mr-2 h-3.5 w-3.5" />}
              Set & save subagents to Auto
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={!selectedTemplate || loading || saving}><Save className="mr-2 h-3.5 w-3.5" />{saving ? 'Saving…' : 'Save policy'}</Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <Badge variant="outline">Precedence: Chat → Mission → Workspace → Team → Scheduler</Badge>
          {selectedTemplate?.id === activeTemplateId && <Badge variant="secondary">Active composer team</Badge>}
          {saved && <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" />Saved</span>}
          {error && <span className="flex items-center gap-1 text-amber-400"><AlertCircle className="h-3.5 w-3.5" />{error}</span>}
          {catalogRefresh.status !== 'idle' && (
            <span
              className={`flex items-center gap-1 ${catalogRefresh.status === 'error' ? 'text-amber-400' : catalogRefresh.status === 'success' ? 'text-emerald-400' : 'text-muted-foreground'}`}
              role={catalogRefresh.status === 'error' ? 'alert' : 'status'}
              aria-live="polite"
            >
              {catalogRefresh.status === 'refreshing' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {catalogRefresh.status === 'success' && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
              {catalogRefresh.status === 'error' && <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />}
              {catalogRefresh.message || 'Refreshing model catalog…'}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && <div className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">Loading team routing policy…</div>}
        {!loading && selectedTemplate?.roles.map((roleDefinition) => (
          <RolePolicyCard
            key={`${selectedTemplate.id}:${roleDefinition.role}`}
            roleDefinition={roleDefinition}
            policy={draft[roleDefinition.role] || policyFromTemplateRole(roleDefinition)}
            accounts={accounts}
            models={models}
            onChange={(patch) => patchRole(roleDefinition.role, patch)}
          />
        ))}
        {!loading && !selectedTemplate && <div className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">No team template is available from the local service.</div>}
      </CardContent>
    </Card>
  );
}

function RolePolicyCard({ roleDefinition, policy, accounts, models, onChange }: {
  roleDefinition: TeamRole;
  policy: RoleExecutionPolicy;
  accounts: AccountProfile[];
  models: DiscoveredModel[];
  onChange: (patch: Partial<RoleExecutionPolicy>) => void;
}) {
  const selectedModel = models.find((model) => model.catalogId === policy.modelCatalogId);
  const selectedAccount = accounts.find((account) => account.id === policy.accountProfileId);
  const initialRuntime = selectedModel?.runtimeType || selectedAccount?.runtimeType || 'all';
  const [runtimeFilter, setRuntimeFilter] = useState<RuntimeFilter>(initialRuntime);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const mode = policy.selectionMode || 'auto';

  const accountOptions = accounts.filter((account) => {
    if (runtimeFilter !== 'all' && account.runtimeType !== runtimeFilter) return false;
    const allowed = account.allowedRoles || [];
    return !allowed.length || allowed.some((role) => role.toLowerCase() === roleDefinition.role.toLowerCase());
  });
  const modelOptions = models.filter((model) => {
    if (runtimeFilter !== 'all' && model.runtimeType !== runtimeFilter) return false;
    if (policy.accountProfileId && model.accountProfileId !== policy.accountProfileId) return false;
    return isRoleCompatible(model, roleDefinition.role);
  });
  const reasoningOptions = selectedModel?.supportedReasoning.length ? selectedModel.supportedReasoning : REASONING_LEVELS;
  const fallbackIds = policy.fallbackCatalogIds || [];
  const fallbackModels = fallbackIds.map((id) => models.find((model) => model.catalogId === id)).filter((model): model is DiscoveredModel => Boolean(model));
  const availableFallbacks = models.filter((model) =>
    model.available
    && isRoleCompatible(model, roleDefinition.role)
    && model.catalogId !== policy.modelCatalogId
    && !fallbackIds.includes(model.catalogId));
  const displayedRuntime = selectedModel?.runtimeType || selectedAccount?.runtimeType || (runtimeFilter === 'all' ? undefined : runtimeFilter);

  const setMode = (selectionMode: RouteSelectionMode) => {
    if (selectionMode === 'auto') {
      onChange({ selectionMode, accountProfileId: undefined, modelCatalogId: undefined, reasoningLevel: undefined, fallbackCatalogIds: [] });
      setDetailsOpen(false);
      return;
    }
    onChange({ selectionMode });
    setDetailsOpen(true);
  };

  const changeRuntimeFilter = (value: string) => {
    const next = (value || 'all') as RuntimeFilter;
    setRuntimeFilter(next);
    const accountValid = !policy.accountProfileId || accounts.some((account) => account.id === policy.accountProfileId && (next === 'all' || account.runtimeType === next));
    const modelValid = !policy.modelCatalogId || models.some((model) => model.catalogId === policy.modelCatalogId && (next === 'all' || model.runtimeType === next));
    if (!accountValid || !modelValid) onChange({ accountProfileId: undefined, modelCatalogId: undefined, reasoningLevel: undefined });
  };

  return (
    <div className="rounded-xl border border-border/70 bg-card/40 p-3 sm:p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {displayedRuntime ? <RuntimeBrandIcon runtimeId={displayedRuntime} className="h-4 w-4 text-primary" /> : <Route className="h-4 w-4 text-muted-foreground" />}
            <span className="text-sm font-semibold">{roleLabel(roleDefinition.role)}</span>
            <Badge variant="outline" className="text-[9px]">{roleDefinition.accessLevel.replaceAll('_', ' ')}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{MODES.find((item) => item.id === mode)?.description}</p>
        </div>
        <div className="flex shrink-0 self-start rounded-lg border border-border bg-background p-1" role="group" aria-label={`${roleLabel(roleDefinition.role)} routing mode`}>
          {MODES.map((item) => <button key={item.id} type="button" aria-pressed={mode === item.id} onClick={() => setMode(item.id)} className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${mode === item.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>{item.label}</button>)}
        </div>
      </div>

      {mode !== 'auto' && (
        <button type="button" aria-expanded={detailsOpen} aria-controls={detailsOpen ? `route-details-${roleDefinition.role}` : undefined} onClick={() => setDetailsOpen(!detailsOpen)} className="mt-3 flex w-full items-center justify-between gap-3 rounded-lg border border-border/70 bg-background/40 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="min-w-0 truncate">{selectedModel?.name || selectedAccount?.profileName || 'Choose a model or connected account'}{fallbackIds.length ? ` · ${fallbackIds.length} fallback${fallbackIds.length === 1 ? '' : 's'}` : ''}</span>
          <span className="flex shrink-0 items-center gap-1 text-foreground">{detailsOpen ? 'Hide settings' : 'Configure route'}<ChevronDown className={`h-3.5 w-3.5 transition-transform ${detailsOpen ? 'rotate-180' : ''}`} /></span>
        </button>
      )}
      {mode === 'fixed' && !policy.modelCatalogId && !policy.accountProfileId && !fallbackIds.length && (
        <p role="alert" className="mt-2 text-xs text-amber-400">Choose a model or account before saving a Fixed route.</p>
      )}

      {mode !== 'auto' && detailsOpen && <div id={`route-details-${roleDefinition.role}`} className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Primary runtime filter">
          <select value={runtimeFilter} onChange={(event) => changeRuntimeFilter(event.target.value)} className={SELECT_CLASS}>
            <option value="all">All connected runtimes</option>
            {RUNTIME_BRANDS.map((runtime) => <option key={runtime.id} value={runtime.id}>{runtime.label}</option>)}
          </select>
        </Field>
        <Field label="Primary account">
          <select value={policy.accountProfileId || ''} onChange={(event) => {
            const account = accounts.find((item) => item.id === event.target.value);
            if (account) setRuntimeFilter(account.runtimeType);
            onChange({ accountProfileId: account?.id, modelCatalogId: undefined, reasoningLevel: undefined, fallbackCatalogIds: [] });
          }} className={SELECT_CLASS}>
            <option value="">Any eligible account</option>
            {accountOptions.map((account) => <option key={account.id} value={account.id}>{account.profileName} · {account.runtimeType}</option>)}
          </select>
        </Field>
        <Field label="Primary model">
          <select value={policy.modelCatalogId || ''} onChange={(event) => {
            const model = models.find((item) => item.catalogId === event.target.value);
            if (model) setRuntimeFilter(model.runtimeType);
            onChange({ modelCatalogId: model?.catalogId, accountProfileId: model?.accountProfileId || policy.accountProfileId, reasoningLevel: model?.defaultReasoning || policy.reasoningLevel, fallbackCatalogIds: fallbackIds.filter((id) => id !== model?.catalogId) });
          }} className={SELECT_CLASS}>
            <option value="">Scheduler choice within account</option>
            {modelOptions.map((model) => <option key={model.catalogId} value={model.catalogId}>{model.name} · {model.accountName}{model.available ? '' : ' · unavailable'}</option>)}
          </select>
        </Field>
        <Field label="Reasoning">
          <select value={policy.reasoningLevel || ''} onChange={(event) => onChange({ reasoningLevel: event.target.value ? event.target.value as CanonicalReasoning : undefined })} className={SELECT_CLASS}>
            <option value="">Role/model default</option>
            {reasoningOptions.map((level) => <option key={level} value={level}>{titleReasoning(level)}</option>)}
          </select>
        </Field>
      </div>}

      {mode !== 'auto' && detailsOpen && <div className="mt-4 rounded-lg border border-border/60 bg-background/50 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div><div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Ordered fallback routes</div><div className="mt-0.5 text-[10px] text-muted-foreground">{mode === 'fixed' ? 'Only the primary route and these exact fallbacks may run; fallbacks may cross account/runtime boundaries.' : mode === 'prefer' ? 'These explicit fallbacks are preferred before the scheduler broadens to other compatible routes.' : 'Auto mode delegates the complete route decision to the scheduler.'}</div></div>
          <select aria-label={`${roleLabel(roleDefinition.role)} fallback model`} value="" onChange={(event) => { if (event.target.value) onChange({ fallbackCatalogIds: [...fallbackIds, event.target.value] }); }} className="h-8 min-w-52 rounded-md border border-input bg-background px-2 text-xs">
            <option value="">+ Add fallback route</option>
            {availableFallbacks.map((model) => <option key={model.catalogId} value={model.catalogId}>{model.name} · {model.accountName} · {model.runtimeType}</option>)}
          </select>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {fallbackModels.map((model, index) => <Badge key={model.catalogId} variant="secondary" className="gap-1 py-1 text-[10px]"><span>{index + 1}.</span><RuntimeBrandIcon runtimeId={model.runtimeType} className="h-3 w-3" />{model.name}<span className="text-muted-foreground">· {model.accountName}</span><button type="button" onClick={() => onChange({ fallbackCatalogIds: fallbackIds.filter((id) => id !== model.catalogId) })} aria-label={`Remove ${model.name} fallback`}><X className="h-3 w-3" /></button></Badge>)}
          {!fallbackModels.length && <span className="flex items-center gap-1 text-[10px] text-muted-foreground"><Plus className="h-3 w-3" />No explicit fallbacks</span>}
        </div>
      </div>}
    </div>
  );
}

function titleReasoning(level: CanonicalReasoning): string {
  return level === 'xhigh' ? 'Extra High' : level.charAt(0).toUpperCase() + level.slice(1);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="space-y-1.5"><span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>{children}</label>;
}
