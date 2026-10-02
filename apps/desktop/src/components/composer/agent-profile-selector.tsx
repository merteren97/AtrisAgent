import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, ChevronDown, Loader2, UsersRound, Settings2, RefreshCw } from 'lucide-react';
import type { AgentRole, CanonicalReasoning, RouteSelectionMode, RuntimeType } from '@atris-agent-code/domain';
import { AGENT_ROLES, parseAgentProfile } from '@atris-agent-code/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { apiRequest } from '@/lib/api-client';
import { useSettingsStore } from '@/stores/settings-store';
import { cn } from '@/lib/utils';
import { useOrchestratorPreferences } from '@/stores/orchestrator-preferences-store';

export interface DesktopAgentProfileRoutePolicy {
  selectionMode?: RouteSelectionMode;
  accountProfileId?: string;
  modelCatalogId?: string;
  reasoningLevel?: CanonicalReasoning;
  fallbackCatalogIds?: string[];
  allowedCatalogIds?: string[];
  allowedModelCatalogIds?: string[];
  allowedAccountProfileIds?: string[];
  allowedRuntimeTypes?: RuntimeType[];
}

/** UI-safe profile data. Unknown API fields are intentionally discarded. */
export interface DesktopAgentProfile {
  id: string;
  name: string;
  role: AgentRole;
  instructions: string;
  capabilities: string[];
  specialty?: string;
  description?: string;
  routePolicy?: DesktopAgentProfileRoutePolicy;
}

export const PROFILE_ROLES = AGENT_ROLES;

const REASONING_LEVELS: CanonicalReasoning[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function profileRoleLabel(role: AgentRole): string {
  return role === 'qa' ? 'QA' : role.charAt(0).toUpperCase() + role.slice(1);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeRoutePolicy(value: unknown): DesktopAgentProfileRoutePolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const selectionMode = record.selectionMode;
  const route: DesktopAgentProfileRoutePolicy = {};
  if (selectionMode === 'auto' || selectionMode === 'prefer' || selectionMode === 'fixed') route.selectionMode = selectionMode;
  const accountProfileId = cleanString(record.accountProfileId);
  if (accountProfileId) route.accountProfileId = accountProfileId;
  const modelCatalogId = cleanString(record.modelCatalogId);
  if (modelCatalogId) route.modelCatalogId = modelCatalogId;
  if (REASONING_LEVELS.includes(record.reasoningLevel as CanonicalReasoning)) route.reasoningLevel = record.reasoningLevel as CanonicalReasoning;
  if (Array.isArray(record.fallbackCatalogIds)) {
    const fallbackCatalogIds = Array.from(new Set(record.fallbackCatalogIds
      .filter((item): item is string => Boolean(cleanString(item)))
      .map((item) => item.trim())));
    if (fallbackCatalogIds.length) route.fallbackCatalogIds = fallbackCatalogIds;
  }
  for (const key of ['allowedCatalogIds', 'allowedModelCatalogIds', 'allowedAccountProfileIds'] as const) {
    if (Array.isArray(record[key])) route[key] = Array.from(new Set(record[key].filter((item): item is string => Boolean(cleanString(item))).map((item) => item.trim())));
  }
  if (Array.isArray(record.allowedRuntimeTypes)) route.allowedRuntimeTypes = record.allowedRuntimeTypes.filter((item): item is RuntimeType => ['codex', 'claude_code', 'antigravity', 'opencode'].includes(String(item)));
  return Object.keys(route).length ? route : undefined;
}

function responseRows(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== 'object') return [];
  const record = input as Record<string, unknown>;
  for (const key of ['profiles', 'agentProfiles', 'items', 'data']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

/** Normalize an untrusted API response into fixed-role, safe display records. */
export function normalizeAgentProfiles(input: unknown): DesktopAgentProfile[] {
  const byId = new Map<string, DesktopAgentProfile>();
  for (const value of responseRows(input)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const roleValue = cleanString(record.role)?.toLowerCase();
    if (!roleValue || !(AGENT_ROLES as readonly string[]).includes(roleValue)) continue;
    const id = cleanString(record.id) || cleanString(record.agentProfileId) || cleanString(record.profileId);
    if (!id) continue;
    const parsed = parseAgentProfile({
      ...record,
      id,
      role: roleValue,
      routePolicy: record.routePolicy || {
        selectionMode: record.selectionMode,
        accountProfileId: record.accountProfileId,
        modelCatalogId: record.modelCatalogId,
        reasoningLevel: record.reasoningLevel,
        fallbackCatalogIds: record.fallbackCatalogIds,
      },
    }, roleValue as AgentRole);
    if (!parsed || parsed.role !== roleValue) continue;
    const profile: DesktopAgentProfile = {
      id: parsed.id,
      name: parsed.name,
      role: parsed.role,
      instructions: parsed.instructions,
      capabilities: [...parsed.capabilities],
      specialty: parsed.specialty,
      description: parsed.description,
      routePolicy: safeRoutePolicy(parsed.routePolicy),
    };
    // Keep the first valid row for duplicate IDs. Never merge rows from
    // different roles because role is the fixed security boundary.
    if (!byId.has(profile.id)) byId.set(profile.id, profile);
  }
  return Array.from(byId.values()).sort((left, right) => {
    const roleDifference = PROFILE_ROLES.indexOf(left.role) - PROFILE_ROLES.indexOf(right.role);
    return roleDifference || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) || left.id.localeCompare(right.id);
  });
}

/** A saved ID is valid only when it still belongs to the same safety role. */
export function invalidAgentProfileRoles(selections: Partial<Record<AgentRole, string>>, profiles: DesktopAgentProfile[]): AgentRole[] {
  return PROFILE_ROLES.filter((role) => Boolean(selections[role]) && !profiles.some((profile) => profile.id === selections[role] && profile.role === role));
}

export function AgentProfileSelector() {
  const { preferences, updatePreferences, scopeKey } = useOrchestratorPreferences();
  const agentProfileIds = preferences.agentProfileIds;
  const setActiveView = useSettingsStore((state) => state.setActiveView);
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [profiles, setProfiles] = useState<DesktopAgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void apiRequest<unknown>('/agent-profiles')
      .then((response) => {
        if (cancelled) return;
        const next = normalizeAgentProfiles(response);
        setProfiles(next);
        const invalid = invalidAgentProfileRoles(agentProfileIds, next);
        if (invalid.length) updatePreferences({ agentProfileIds: Object.fromEntries(Object.entries(agentProfileIds).filter(([role]) => !invalid.includes(role as AgentRole))) });
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Specialists could not be loaded.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [refresh, updatePreferences, scopeKey, agentProfileIds]);

  const selectedCount = useMemo(
    () => PROFILE_ROLES.filter((role) => Boolean(agentProfileIds[role])).length,
    [agentProfileIds],
  );

  return (
    <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (next) setRefresh((current) => current + 1); }}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 max-w-[150px] gap-1 px-2 text-[10px] text-muted-foreground hover:text-foreground"
          aria-label={selectedCount ? `${selectedCount} specialists selected` : 'Select saved specialists'}
          title="Saved specialists by safety role"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin text-primary" aria-hidden="true" /> : <UsersRound className="h-3 w-3" aria-hidden="true" />}
          <span className="truncate">Specialists{selectedCount ? ` · ${selectedCount}` : ''}</span>
          <ChevronDown className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-[min(380px,calc(100vw-2rem))] p-2"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-border px-2 pb-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold">Saved specialists</div>
            <Badge variant="outline" className="text-[9px]">Optional overrides</Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Optional overrides for this run. Unselected roles use automatic specialist selection and saved defaults.</p>
        </div>
        <div className="max-h-[360px] space-y-1 overflow-y-auto py-2">
          {PROFILE_ROLES.filter((role) => profiles.some((profile) => profile.role === role) || agentProfileIds[role]).map((role) => {
            const roleProfiles = profiles.filter((profile) => profile.role === role);
            const selectedId = agentProfileIds[role] || '';
            const selected = roleProfiles.find((profile) => profile.id === selectedId);
            return (
              <label key={role} htmlFor={`agent-profile-${role}`} className="block rounded-lg border border-border/60 bg-background/40 p-2">
                <span className="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold">
                  <span>{profileRoleLabel(role)}</span>
                  {selected && <span className="flex min-w-0 items-center gap-1 text-primary"><Check className="h-3 w-3 shrink-0" aria-hidden="true" /><span className="max-w-[190px] truncate">{selected.name}</span></span>}
                </span>
                <select
                  id={`agent-profile-${role}`}
                  aria-label={`Specialist for ${profileRoleLabel(role)}`}
                  value={selectedId}
                  disabled={loading || Boolean(error)}
                  onChange={(event) => updatePreferences({ agentProfileIds: Object.fromEntries(Object.entries({ ...agentProfileIds, [role]: event.target.value }).filter(([, id]) => id)) })}
                  className={cn('h-8 w-full rounded-md border border-input bg-background px-2 text-[10px] outline-none focus:border-primary', selectedId ? 'text-foreground' : 'text-muted-foreground')}
                >
                  <option value="">Automatic {profileRoleLabel(role)}</option>
                  {roleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                  {selectedId && !selected && <option value={selectedId}>Saved specialist (not verified)</option>}
                </select>
                {selected?.description && <span className="mt-1 block truncate text-[9px] text-muted-foreground">{selected.description}</span>}
              </label>
            );
          })}
        </div>
        {!loading && !error && !profiles.length && <p className="px-2 pb-2 text-xs leading-relaxed text-muted-foreground">No saved specialists yet. The orchestrator uses built-in role defaults to assemble your team.</p>}
        {loading && <div role="status" className="flex items-center gap-2 px-2 pb-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Loading specialists…</div>}
        {error && <div role="alert" className="space-y-2 px-2 pb-2 text-xs text-destructive"><div className="flex items-start gap-2"><AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /><span className="min-w-0 break-words">{error}</span></div><Button variant="outline" size="sm" onClick={() => setRefresh((current) => current + 1)}><RefreshCw className="mr-1 h-3 w-3" />Retry</Button></div>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setActiveView('agents')}><Settings2 className="h-4 w-4" />{profiles.length ? 'Manage specialists' : 'Create a specialist'}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
