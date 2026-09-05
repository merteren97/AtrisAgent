import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, ChevronDown, Loader2, UsersRound } from 'lucide-react';
import type { AgentRole, CanonicalReasoning, RouteSelectionMode } from '@atris-agent-code/domain';
import { AGENT_ROLES, parseAgentProfile } from '@atris-agent-code/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { apiRequest } from '@/lib/api-client';
import { useSettingsStore } from '@/stores/settings-store';
import { cn } from '@/lib/utils';

export interface DesktopAgentProfileRoutePolicy {
  selectionMode?: RouteSelectionMode;
  accountProfileId?: string;
  modelCatalogId?: string;
  reasoningLevel?: CanonicalReasoning;
  fallbackCatalogIds?: string[];
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

export function AgentProfileSelector() {
  const agentProfileIds = useSettingsStore((state) => state.agentProfileIds);
  const setAgentProfileId = useSettingsStore((state) => state.setAgentProfileId);
  const [profiles, setProfiles] = useState<DesktopAgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void apiRequest<unknown>('/agent-profiles')
      .then((response) => {
        if (!cancelled) setProfiles(normalizeAgentProfiles(response));
      })
      .catch((cause) => {
        if (!cancelled) {
          setProfiles([]);
          setError(cause instanceof Error ? cause.message : 'Named profiles are unavailable.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const selectedCount = useMemo(
    () => PROFILE_ROLES.filter((role) => Boolean(agentProfileIds[role])).length,
    [agentProfileIds],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 max-w-[150px] gap-1 px-2 text-[10px] text-muted-foreground hover:text-foreground"
          aria-label={selectedCount ? `${selectedCount} named agent profiles selected` : 'Select named agent profiles'}
          title="Optional named profiles by fixed role"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin text-primary" aria-hidden="true" /> : <UsersRound className="h-3 w-3" aria-hidden="true" />}
          <span className="truncate">Profiles{selectedCount ? ` Â· ${selectedCount}` : ''}</span>
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
            <div className="text-xs font-semibold">Named profiles</div>
            <Badge variant="outline" className="text-[9px]">Optional overrides</Badge>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Choose a safe named identity for each fixed role. Empty roles use the team/default profile.</p>
        </div>
        <div className="max-h-[360px] space-y-1 overflow-y-auto py-2">
          {PROFILE_ROLES.map((role) => {
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
                  aria-label={`Named profile for ${profileRoleLabel(role)}`}
                  value={selectedId}
                  onChange={(event) => setAgentProfileId(role, event.target.value || null)}
                  className={cn('h-8 w-full rounded-md border border-input bg-background px-2 text-[10px] outline-none focus:border-primary', selectedId ? 'text-foreground' : 'text-muted-foreground')}
                >
                  <option value="">Default {profileRoleLabel(role)}</option>
                  {roleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
                {selected?.description && <span className="mt-1 block truncate text-[9px] text-muted-foreground">{selected.description}</span>}
                {!loading && roleProfiles.length === 0 && <span className="mt-1 block text-[9px] text-muted-foreground">No named profile; the runtime default remains active.</span>}
              </label>
            );
          })}
        </div>
        {loading && <div className="flex items-center gap-2 border-t border-border px-2 pt-2 text-[10px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Loading profilesâ€¦</div>}
        {error && <div role="alert" className="flex items-start gap-2 border-t border-border px-2 pt-2 text-[10px] text-amber-400"><AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /><span>Profile catalog unavailable; saved selections are verified when you run.</span></div>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
