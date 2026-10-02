import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain,
  Search,
  Shield,
  Plus,
  Wrench,
  Eye,
  Loader2,
  RefreshCw,
  AlertTriangle,
  Pencil,
  Trash2,
  Star,
  MoreHorizontal,
  Route,
  Save,
  UsersRound,
} from 'lucide-react';
import type { AccountProfile, AgentRole, CanonicalReasoning, TeamTemplate, TeamRole } from '@atris-agent-code/domain';
import { apiRequest } from '@/lib/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { OrchestratorDefaults } from '@/components/orchestrator/orchestrator-defaults';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { normalizeTeamTemplates } from '@/lib/team-template-utils';
import { cn } from '@/lib/utils';
import {
  PROFILE_ROLES,
  normalizeAgentProfiles,
  profileRoleLabel,
  type DesktopAgentProfile,
  type DesktopAgentProfileRoutePolicy,
} from '@/components/composer/agent-profile-selector';
import { useAccountStore, type DiscoveredModel as DesktopDiscoveredModel } from '@/stores/account-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

const ROLE_UI: Record<AgentRole, { icon: typeof Brain; badgeColor: string; label: string; access: TeamRole['accessLevel']; capabilities: string[] }> = {
  orchestrator: { icon: Brain, badgeColor: 'bg-purple-500/10 text-purple-400 border-purple-500/20', label: 'Orchestrator', access: 'orchestration', capabilities: ['planning', 'delegation', 'evaluation'] },
  builder: { icon: Wrench, badgeColor: 'bg-green-500/10 text-green-400 border-green-500/20', label: 'Builder', access: 'write', capabilities: ['workspace-write', 'run-command'] },
  reviewer: { icon: Eye, badgeColor: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20', label: 'Reviewer', access: 'read', capabilities: ['code-review', 'security-review'] },
  researcher: { icon: Search, badgeColor: 'bg-blue-500/10 text-blue-400 border-blue-500/20', label: 'Researcher', access: 'read', capabilities: ['research', 'documentation'] },
  qa: { icon: Shield, badgeColor: 'bg-orange-500/10 text-orange-400 border-orange-500/20', label: 'QA', access: 'tests_and_build', capabilities: ['build', 'test', 'lint'] },
};
const ALL_ROLES = Object.keys(ROLE_UI) as AgentRole[];
const ROLE_HELP: Record<AgentRole, string> = {
  orchestrator: 'Orchestrator — plans and delegates work',
  builder: 'Builder — edits files and runs commands',
  reviewer: 'Reviewer — reviews code with read-only access',
  researcher: 'Researcher — investigates with read-only access',
  qa: 'QA — runs tests, builds and lint checks',
};
const PROFILE_REASONING_LEVELS: CanonicalReasoning[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PROFILE_SELECTION_MODES: Array<{ value: NonNullable<DesktopAgentProfileRoutePolicy['selectionMode']>; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'prefer', label: 'Prefer this route' },
  { value: 'fixed', label: 'Fixed route' },
];
const SELECT_CLASS = 'h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60';
type ProfileBindingScope = 'global' | 'workspace' | 'team_template';

type TemplateDraft = { name: string; description: string; roles: AgentRole[] };
export type AgentProfileDraft = {
  name: string;
  role: AgentRole;
  description: string;
  specialty: string;
  instructions: string;
  capabilities: string;
  selectionMode: NonNullable<DesktopAgentProfileRoutePolicy['selectionMode']>;
  accountProfileId: string;
  modelCatalogId: string;
  reasoningLevel: CanonicalReasoning | '';
};

export function emptyAgentProfileDraft(role: AgentRole = 'researcher'): AgentProfileDraft {
  return {
    name: '',
    role,
    description: '',
    specialty: '',
    instructions: '',
    capabilities: '',
    selectionMode: 'auto',
    accountProfileId: '',
    modelCatalogId: '',
    reasoningLevel: '',
  };
}

function profileDraftFrom(profile: DesktopAgentProfile): AgentProfileDraft {
  const route = profile.routePolicy;
  return {
    name: profile.name,
    role: profile.role,
    description: profile.description || '',
    specialty: profile.specialty || '',
    instructions: profile.instructions,
    capabilities: profile.capabilities.join(', '),
    selectionMode: route?.selectionMode || 'auto',
    accountProfileId: route?.accountProfileId || '',
    modelCatalogId: route?.modelCatalogId || '',
    reasoningLevel: route?.reasoningLevel || '',
  };
}

function normalizedCapabilities(value: string): string[] {
  return Array.from(new Set(value.split(',')
    .map((item) => item.trim())
    .filter(Boolean)))
    .slice(0, 24);
}

/** Build the safe API payload; role is intentionally omitted for edits. */
export function toAgentProfilePayload(draft: AgentProfileDraft, includeRole = true, existingRoute?: DesktopAgentProfileRoutePolicy): Record<string, unknown> {
  const routePolicy: DesktopAgentProfileRoutePolicy = {
    ...existingRoute,
    selectionMode: draft.selectionMode,
    ...(includeRole && !draft.accountProfileId.trim() ? {} : { accountProfileId: draft.accountProfileId.trim() || undefined }),
    ...(includeRole && !draft.modelCatalogId.trim() ? {} : { modelCatalogId: draft.modelCatalogId.trim() || undefined }),
    ...(includeRole && !draft.reasoningLevel ? {} : { reasoningLevel: draft.reasoningLevel || undefined }),
  };
  const hasRoutePolicy = Object.keys(routePolicy).some((key) => key !== 'selectionMode' || routePolicy.selectionMode !== 'auto');
  return {
    ...(includeRole ? { role: draft.role } : {}),
    name: draft.name.trim(),
    ...(!includeRole || draft.description.trim() ? { description: draft.description.trim() } : {}),
    ...(!includeRole || draft.specialty.trim() ? { specialty: draft.specialty.trim() } : {}),
    instructions: draft.instructions.trim(),
    capabilities: normalizedCapabilities(draft.capabilities),
    ...(hasRoutePolicy || !includeRole ? { routePolicy } : {}),
  };
}

function modelSupportsProfileRole(model: DesktopDiscoveredModel, role: AgentRole): boolean {
  return model.suitableRoles.length === 0 || model.suitableRoles.some((candidate) => candidate.toLowerCase() === role);
}

export function validateAgentProfileDraft(draft: AgentProfileDraft, accounts: AccountProfile[], models: DesktopDiscoveredModel[], existingRoute?: DesktopAgentProfileRoutePolicy): string | null {
  if (!draft.name.trim()) return 'Give this specialist a name.';
  if (draft.selectionMode === 'fixed' && !draft.accountProfileId && !draft.modelCatalogId && !existingRoute?.fallbackCatalogIds?.length) return 'A fixed route needs an account or model. Choose one in Advanced options.';
  const model = models.find((item) => item.catalogId === draft.modelCatalogId);
  const accountId = draft.accountProfileId || model?.accountProfileId;
  const account = accounts.find((item) => item.id === accountId);
  if (accountId && !account) return 'The selected account is no longer available. Choose another account or clear the preference.';
  if (account?.allowedRoles?.length && !account.allowedRoles.some((role) => role.toLowerCase() === draft.role)) return 'The selected account does not allow this safety role.';
  if (draft.modelCatalogId && !model) return 'The selected model is no longer in the catalog. Refresh accounts or choose another model.';
  if (model && !modelSupportsProfileRole(model, draft.role)) return 'The selected model does not support this safety role.';
  if (model && draft.accountProfileId && model.accountProfileId !== draft.accountProfileId) return 'The selected model belongs to a different account. Choose a matching account or model.';
  if (model && draft.reasoningLevel && !model.supportedReasoning.includes(draft.reasoningLevel)) return 'The selected model does not support this reasoning level. Choose Model default or a supported level.';
  if (!model && draft.reasoningLevel && !models.some((item) => modelSupportsProfileRole(item, draft.role) && (!accountId || item.accountProfileId === accountId) && item.supportedReasoning.includes(draft.reasoningLevel as CanonicalReasoning))) return 'No compatible model supports this reasoning level. Choose Model default or a compatible model.';
  return null;
}

function profileRouteSummary(profile: DesktopAgentProfile, accounts: AccountProfile[], models: DesktopDiscoveredModel[]): string {
  const route = profile.routePolicy;
  if (!route || (!route.accountProfileId && !route.modelCatalogId && route.selectionMode !== 'fixed')) return 'Automatic route · scheduler chooses a compatible connected model';
  const account = accounts.find((item) => item.id === route.accountProfileId);
  const model = models.find((item) => item.catalogId === route.modelCatalogId);
  if (model) {
    const status = model.available ? 'available' : model.availability === 'unknown' ? 'unknown · verify at run' : 'unavailable · verify at run';
    return `${model.name} · ${status}`;
  }
  if (route.modelCatalogId) return 'Saved model route · unavailable · verify at run';
  if (account) {
    const status = account.authStatus === 'connected' ? 'connected' : `${account.authStatus.replaceAll('_', ' ')} · verify at run`;
    return `${account.profileName} · ${status}`;
  }
  if (route.accountProfileId) return 'Saved account route · unavailable · verify at run';
  return `${route.selectionMode === 'fixed' ? 'Fixed' : 'Preferred'} route · verify at run`;
}

function draftFromTemplate(template?: TeamTemplate): TemplateDraft {
  return {
    name: template?.name || '',
    description: template?.description || '',
    roles: template?.roles.map((role) => role.role) || ALL_ROLES,
  };
}

function rolesFromDraft(selectedRoles: AgentRole[]): TeamRole[] {
  return selectedRoles.map((role) => ({
    role,
    modelProfileId: '',
    accountProfileId: '',
    defaultCapabilities: ROLE_UI[role].capabilities,
    accessLevel: ROLE_UI[role].access,
  }));
}

export function AgentsView() {
  const [managementView, setManagementView] = useState<'profiles' | 'templates' | 'defaults'>('profiles');
  const scrollRoot = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRoot.current?.scrollTo({top:0}); }, [managementView]);
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<TeamTemplate | null>(null);
  const [draft, setDraft] = useState<TemplateDraft>(draftFromTemplate());
  const [deleteTarget, setDeleteTarget] = useState<TeamTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyTemplateId, setBusyTemplateId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<DesktopAgentProfile[]>([]);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<DesktopAgentProfile | null>(null);
  const [profileDraft, setProfileDraft] = useState<AgentProfileDraft>(emptyAgentProfileDraft());
  const [profileDeleteTarget, setProfileDeleteTarget] = useState<DesktopAgentProfile | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileEditorError, setProfileEditorError] = useState<string | null>(null);
  const [profileSearch, setProfileSearch] = useState('');
  const [profileRoleFilter, setProfileRoleFilter] = useState<AgentRole | 'all'>('all');
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);
  const accounts = useAccountStore((state) => state.accounts);
  const discoveredModels = useAccountStore((state) => state.discoveredModels);
  const fetchAccounts = useAccountStore((state) => state.fetchAccounts);
  const accountError = useAccountStore((state) => state.error);
  const modelCatalogError = useAccountStore((state) => state.modelCatalogError);
  const accountLoading = useAccountStore((state) => state.loading || state.modelCatalogLoading);
  const visibleProfiles = useMemo(() => profiles.filter((profile) =>
    (profileRoleFilter === 'all' || profile.role === profileRoleFilter)
    && `${profile.name} ${profile.specialty || ''} ${profile.description || ''}`.toLowerCase().includes(profileSearch.trim().toLowerCase()),
  ), [profiles, profileSearch, profileRoleFilter]);
  const draftModels = discoveredModels.filter((model) => modelSupportsProfileRole(model, profileDraft.role) && (!profileDraft.accountProfileId || model.accountProfileId === profileDraft.accountProfileId));
  const draftModel = discoveredModels.find((model) => model.catalogId === profileDraft.modelCatalogId);
  const draftReasoningLevels = PROFILE_REASONING_LEVELS.filter((level) => draftModel ? draftModel.supportedReasoning.includes(level) : draftModels.some((model) => model.supportedReasoning.includes(level)));
  const profileValidation = validateAgentProfileDraft(profileDraft, accounts, discoveredModels, editingProfile?.routePolicy);
  const profilesByRole = useMemo(() => new Map(
    PROFILE_ROLES.map((role) => [role, profiles.filter((profile) => profile.role === role)] as const),
  ), [profiles]);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [bindingScope, setBindingScope] = useState<ProfileBindingScope>('global');
  const [bindingScopeId, setBindingScopeId] = useState('global');
  const [bindings, setBindings] = useState<Partial<Record<AgentRole, string>>>({});
  const [bindingProfileIds, setBindingProfileIds] = useState<Partial<Record<AgentRole, string[]>>>({});
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [bindingBusyRole, setBindingBusyRole] = useState<AgentRole | null>(null);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const bindingRequest = useRef(0);

  const loadBindings = async (scope: ProfileBindingScope, scopeId: string) => {
    const request = ++bindingRequest.current;
    setBindingError(null);
    setBindings({});
    setBindingProfileIds({});
    if (!scopeId) { setBindingsLoading(false); return; }
    setBindingsLoading(true);
    try {
      const rows = await apiRequest<unknown>(`/agent-profiles/bindings?scopeType=${encodeURIComponent(scope)}&scopeId=${encodeURIComponent(scopeId)}`);
      if (request !== bindingRequest.current) return;
      const next: Partial<Record<AgentRole, string>> = {};
      const boundIds: Partial<Record<AgentRole, string[]>> = {};
      if (Array.isArray(rows)) rows.forEach((row) => {
        if (!row || typeof row !== 'object') return;
        const record = row as Record<string, unknown>;
        const role = typeof record.role === 'string' ? record.role.toLowerCase() as AgentRole : null;
        const profileId = typeof record.profileId === 'string' ? record.profileId : typeof record.agentProfileId === 'string' ? record.agentProfileId : '';
        if (!role || !PROFILE_ROLES.includes(role) || !profileId) return;
        boundIds[role] = [...(boundIds[role] || []), profileId];
        if (record.isDefault === true) next[role] = profileId;
      });
      setBindings(next);
      setBindingProfileIds(boundIds);
    } catch (cause) {
      if (request === bindingRequest.current) setBindingError(cause instanceof Error ? cause.message : 'Specialist bindings could not be loaded.');
    } finally { if (request === bindingRequest.current) setBindingsLoading(false); }
  };

  useEffect(() => {
    const nextId = bindingScope === 'global' ? 'global' : bindingScope === 'workspace' ? (activeWorkspaceId || '') : (templates[0]?.id || '');
    setBindingScopeId((current) => bindingScope === 'global' ? 'global' : bindingScope === 'workspace' && workspaces.some((workspace) => workspace.id === current) ? current : bindingScope === 'team_template' && templates.some((template) => template.id === current) ? current : nextId);
  }, [bindingScope, activeWorkspaceId, templates, workspaces]);

  useEffect(() => { void loadBindings(bindingScope, bindingScopeId); }, [bindingScope, bindingScopeId]);

  const saveBinding = async (role: AgentRole, profileId: string) => {
    if (!bindingScopeId) return;
    setBindingBusyRole(role);
    setBindingError(null);
    try {
      if (profileId) {
        await apiRequest('/agent-profiles/bindings', { method: 'PUT', body: JSON.stringify({ scopeType: bindingScope, scopeId: bindingScopeId, role, profileId, isDefault: true }) });
      } else if (bindings[role]) {
        // Keep the profile eligible for prompt-based specialist selection while
        // clearing only its default status for this scope.
        await apiRequest('/agent-profiles/bindings', { method: 'PUT', body: JSON.stringify({ scopeType: bindingScope, scopeId: bindingScopeId, role, profileId: bindings[role], isDefault: false }) });
      }
      setBindings((current) => ({ ...current, [role]: profileId || undefined }));
      if (profileId) setBindingProfileIds((current) => ({ ...current, [role]: Array.from(new Set([...(current[role] || []), profileId])) }));
    } catch (cause: any) {
      setBindingError(cause?.message || 'Specialist default could not be saved.');
    } finally { setBindingBusyRole(null); }
  };

  const toggleWorkspaceSpecialist = async (profile: DesktopAgentProfile, enabled: boolean) => {
    if (bindingScope !== 'workspace' || !bindingScopeId) return;
    setBindingBusyRole(profile.role);
    setBindingError(null);
    try {
      if (enabled) {
        await apiRequest('/agent-profiles/bindings', { method: 'PUT', body: JSON.stringify({ scopeType: 'workspace', scopeId: bindingScopeId, role: profile.role, profileId: profile.id, isDefault: false }) });
      } else {
        await apiRequest(`/agent-profiles/bindings?scopeType=workspace&scopeId=${encodeURIComponent(bindingScopeId)}&profileId=${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
      }
      await loadBindings('workspace', bindingScopeId);
    } catch (cause: any) {
      setBindingError(cause?.message || 'Workspace specialist pool could not be updated.');
    } finally { setBindingBusyRole(null); }
  };

  const loadTemplates = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const items = await apiRequest<TeamTemplate[]>('/team-templates');
      setTemplates(normalizeTeamTemplates(items));
    } catch (cause: any) {
      setTemplates([]);
      setError(cause?.message || 'Team templates could not be loaded from the local service.');
    } finally {
      setIsLoading(false);
    }
  };

  const loadProfiles = async () => {
    setProfileLoading(true);
    setProfileError(null);
    try {
      const response = await apiRequest<unknown>('/agent-profiles');
      setProfiles(normalizeAgentProfiles(response));
    } catch (cause: any) {
      setProfiles([]);
      setProfileError(cause?.message || 'Named profiles could not be loaded from the local service.');
    } finally {
      setProfileLoading(false);
    }
  };

  useEffect(() => {
    void loadTemplates();
    void loadProfiles();
  }, []);

  useEffect(() => {
    if (!accounts.length) void fetchAccounts();
  }, [accounts.length, fetchAccounts]);

  const openCreate = () => {
    setError(null);
    setEditingTemplate(null);
    setDraft(draftFromTemplate());
    setEditorOpen(true);
  };

  const openEdit = (template: TeamTemplate) => {
    setError(null);
    setEditingTemplate(template);
    setDraft(draftFromTemplate(template));
    setEditorOpen(true);
  };

  const saveTemplate = async () => {
    if (!draft.name.trim() || draft.roles.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const payload = JSON.stringify({
        name: draft.name.trim(),
        description: draft.description.trim(),
        roles: rolesFromDraft(draft.roles).map((role) => editingTemplate?.roles.find((existing) => existing.role === role.role) || role),
      });
      if (editingTemplate) {
        await apiRequest(`/team-templates/${editingTemplate.id}`, { method: 'PATCH', body: payload });
      } else {
        await apiRequest('/team-templates', { method: 'POST', body: payload });
      }
      setEditorOpen(false);
      await loadTemplates();
    } catch (cause: any) {
      setError(cause?.message || 'Template save failed.');
    } finally {
      setSaving(false);
    }
  };

  const setDefault = async (template: TeamTemplate) => {
    setBusyTemplateId(template.id);
    setError(null);
    try {
      await apiRequest(`/team-templates/${template.id}/default`, { method: 'POST' });
      await loadTemplates();
    } catch (cause: any) {
      setError(cause?.message || 'Could not set the default template.');
    } finally {
      setBusyTemplateId(null);
    }
  };

  const deleteTemplate = async () => {
    if (!deleteTarget) return;
    setBusyTemplateId(deleteTarget.id);
    setError(null);
    try {
      await apiRequest(`/team-templates/${deleteTarget.id}`, { method: 'DELETE' });
      setDeleteTarget(null);
      await loadTemplates();
    } catch (cause: any) {
      setError(cause?.message || 'Template deletion failed.');
    } finally {
      setBusyTemplateId(null);
    }
  };

  const openCreateProfile = () => {
    setProfileEditorError(null);
    setEditingProfile(null);
    setProfileDraft(emptyAgentProfileDraft());
    setProfileEditorOpen(true);
    void fetchAccounts();
  };

  const openEditProfile = (profile: DesktopAgentProfile) => {
    setProfileEditorError(null);
    setEditingProfile(profile);
    setProfileDraft(profileDraftFrom(profile));
    setProfileEditorOpen(true);
    void fetchAccounts();
  };

  const saveProfile = async () => {
    if (profileValidation) { setProfileEditorError(profileValidation); return; }
    setProfileSaving(true);
    setProfileEditorError(null);
    try {
      const editing = Boolean(editingProfile);
      const path = editing
        ? `/agent-profiles/${encodeURIComponent(editingProfile!.id)}`
        : '/agent-profiles';
      await apiRequest(path, {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify(toAgentProfilePayload(profileDraft, !editing, editingProfile?.routePolicy)),
      });
      setProfileEditorOpen(false);
      await loadProfiles();
    } catch (cause: any) {
      setProfileEditorError(cause?.message || 'Specialist save failed.');
    } finally {
      setProfileSaving(false);
    }
  };

  const deleteProfile = async () => {
    if (!profileDeleteTarget) return;
    const target = profileDeleteTarget;
    setBusyProfileId(target.id);
    setProfileError(null);
    try {
      await apiRequest(`/agent-profiles/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      setProfileDeleteTarget(null);
      await loadProfiles();
      await loadBindings(bindingScope, bindingScopeId);
    } catch (cause: any) {
      setProfileError(cause?.message || 'Profile deletion failed.');
    } finally {
      setBusyProfileId(null);
    }
  };

  return (
    <div ref={scrollRoot} className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-background p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-6 pb-10">
        <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Teams &amp; specialists</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Save expertise for repeat work, reuse a team, and set how your orchestrator delegates.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={isLoading || profileLoading} onClick={() => { void loadTemplates(); void loadProfiles(); }}><RefreshCw className={cn('mr-2 h-4 w-4', (isLoading || profileLoading) && 'animate-spin')} />Refresh</Button>
            {managementView === 'profiles' && <Button size="sm" onClick={openCreateProfile}><Plus className="mr-2 h-4 w-4" />New specialist</Button>}
            {managementView === 'templates' && <Button size="sm" onClick={openCreate}><Plus className="mr-2 h-4 w-4" />New template</Button>}
          </div>
        </div>

        <Tabs value={managementView} onValueChange={(value) => setManagementView(value as typeof managementView)} className="gap-5">
        <TabsList aria-label="Teams and specialists" variant="line" className="border-b border-border pb-2">
          <TabsTrigger value="profiles">Specialists</TabsTrigger>
          <TabsTrigger value="templates">Teams</TabsTrigger>
          <TabsTrigger value="defaults">Defaults</TabsTrigger>
        </TabsList>
        <TabsContent value="profiles" className="space-y-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Saved specialists</h2>
              <p className="text-sm text-muted-foreground">Reusable instructions and expertise, each within a fixed safety role.</p>
            </div>
            <Badge variant="outline" className="w-fit text-[10px]">{profiles.length} saved</Badge>
          </div>
          {profileError && <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span className="break-words">{profileError}</span></div>}
          {profiles.length > 0 && <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input aria-label="Search specialists" placeholder="Search name or specialty…" value={profileSearch} onChange={(event) => setProfileSearch(event.target.value)} className="pl-9" /></div>
            <select aria-label="Filter specialists by safety role" className={cn(SELECT_CLASS, 'sm:w-44')} value={profileRoleFilter} onChange={(event) => setProfileRoleFilter(event.target.value as AgentRole | 'all')}><option value="all">All safety roles</option>{PROFILE_ROLES.map((role) => <option key={role} value={role}>{profileRoleLabel(role)}</option>)}</select>
          </div>}
          {profileLoading ? (
            <div role="status" className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading specialists…</div>
          ) : profiles.length ? (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {visibleProfiles.map((profile) => {
                const config = ROLE_UI[profile.role];
                const Icon = config.icon;
                return (
                  <li key={profile.id} className="flex min-w-0 items-start gap-3 p-4">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className="h-4 w-4" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><button type="button" onClick={() => openEditProfile(profile)} className="min-w-0 break-words text-left text-sm font-medium hover:underline focus-visible:outline-ring">{profile.name}</button><Badge variant="outline" className="text-[10px]">{config.label}</Badge></div>
                      <p className="mt-1 break-words text-xs text-muted-foreground">{profile.specialty || profile.description || 'Custom instructions for repeat work'}</p>
                      <div className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground"><Route className="mt-0.5 h-3 w-3 shrink-0" /><span className="break-words">{profileRouteSummary(profile, accounts, discoveredModels)}</span></div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={`Actions for ${profile.name}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => openEditProfile(profile)}><Pencil className="h-4 w-4" />Edit specialist</DropdownMenuItem><DropdownMenuItem variant="destructive" onClick={() => { setProfileError(null); setProfileDeleteTarget(profile); }} disabled={busyProfileId === profile.id}><Trash2 className="h-4 w-4" />Delete specialist</DropdownMenuItem></DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
              {!visibleProfiles.length && <li className="p-6 text-center text-sm text-muted-foreground">No specialists match your search. <Button variant="link" size="sm" onClick={() => { setProfileSearch(''); setProfileRoleFilter('all'); }}>Clear filters</Button></li>}
            </ul>
          ) : !profileError && <div className="rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center">
            <UsersRound className="mx-auto h-7 w-7 text-muted-foreground" aria-hidden="true" />
            <h3 className="mt-3 text-base font-semibold">Your automatic team is ready</h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">The orchestrator assigns work to built-in roles as needed. Save a specialist when a task needs repeatable expertise or custom instructions.</p>
            <Button className="mt-5" size="sm" onClick={openCreateProfile}><Plus className="mr-2 h-4 w-4" />Create your first specialist</Button>
          </div>}
        </TabsContent>

        <TabsContent value="defaults" className="space-y-5">
          <OrchestratorDefaults />
          <details className="rounded-xl border border-border bg-card">
          <summary className="cursor-pointer rounded-xl px-4 py-3 text-sm font-medium focus-visible:outline-ring">Advanced specialist bindings <span className="ml-2 font-normal text-muted-foreground">Global, workspace &amp; template</span></summary>
          <div className="space-y-3 p-4 pt-1">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-base font-semibold tracking-tight">Safety-role defaults</h2>
              <p className="text-sm text-muted-foreground">Bind reusable profiles at global, workspace, or team-template scope. Conversation model instructions take precedence over these defaults.</p>
            </div>
            {bindingsLoading && <Badge variant="outline" className="w-fit text-[10px]"><Loader2 className="mr-1 h-3 w-3 animate-spin" />Loading</Badge>}
          </div>
          {bindingError && <div role="alert" className="break-words rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{bindingError}</div>}
          <Card className="border-border/80 bg-card/70">
            <CardContent className="space-y-4 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="profile-binding-scope">Default scope</Label>
                  <select id="profile-binding-scope" className={SELECT_CLASS} disabled={Boolean(bindingBusyRole)} value={bindingScope} onChange={(event) => setBindingScope(event.target.value as ProfileBindingScope)}>
                    <option value="global">Global defaults</option>
                    <option value="workspace">This workspace</option>
                    <option value="team_template">Team template</option>
                  </select>
                </div>
                {bindingScope === 'workspace' ? (
                  <div className="space-y-2"><Label htmlFor="profile-binding-workspace">Workspace</Label><select id="profile-binding-workspace" className={SELECT_CLASS} disabled={Boolean(bindingBusyRole)} value={bindingScopeId} onChange={(event) => setBindingScopeId(event.target.value)}><option value="">Choose a workspace</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></div>
                ) : bindingScope === 'team_template' ? (
                  <div className="space-y-2"><Label htmlFor="profile-binding-template">Team template</Label><select id="profile-binding-template" className={SELECT_CLASS} disabled={Boolean(bindingBusyRole)} value={bindingScopeId} onChange={(event) => setBindingScopeId(event.target.value)}><option value="">Choose a team template</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></div>
                ) : <div className="flex items-end text-[11px] text-muted-foreground">Applies when no workspace or team-template default exists.</div>}
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {PROFILE_ROLES.map((role) => {
                  const roleProfiles = profilesByRole.get(role) || [];
                  return <div key={`binding-${role}`} className="space-y-1.5 rounded-xl border border-border/70 bg-muted/20 p-3">
                    <Label htmlFor={`binding-${role}`} className="text-xs">{profileRoleLabel(role)} default</Label>
                    <select id={`binding-${role}`} className={SELECT_CLASS} disabled={!bindingScopeId || bindingsLoading || Boolean(bindingBusyRole) || Boolean(bindingError)} value={bindings[role] || ''} onChange={(event) => void saveBinding(role, event.target.value)}>
                      <option value="">Runtime role default</option>
                      {roleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                      {bindings[role] && !roleProfiles.some((profile) => profile.id === bindings[role]) && <option value={bindings[role]}>Saved specialist unavailable</option>}
                    </select>
                    <p className="text-[10px] text-muted-foreground">{roleProfiles.length ? 'Fixed role is validated by the service.' : 'Create a profile for this role first.'}</p>
                  </div>;
                })}
              </div>
              {bindingScope === 'workspace' && bindingScopeId && (
                <div className="space-y-3 border-t border-border/70 pt-4">
                  <div>
                    <h3 className="text-sm font-medium">Workspace specialist pool</h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Selected profiles may be assigned to matching tasks from the user's prompt. Role defaults remain the fallback when no specialist fits.</p>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {PROFILE_ROLES.filter((role) => role !== 'orchestrator').map((role) => {
                      const roleProfiles = profilesByRole.get(role) || [];
                      return <div key={`specialist-pool-${role}`} className="space-y-1.5 rounded-xl border border-border/70 bg-muted/20 p-3">
                        <div className="text-xs font-medium">{profileRoleLabel(role)}</div>
                        {roleProfiles.length ? roleProfiles.map((profile) => (
                          <label key={profile.id} className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1.5 text-xs hover:bg-muted/40">
                            <input
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                              checked={(bindingProfileIds[role] || []).includes(profile.id)}
                              disabled={bindingsLoading || Boolean(bindingBusyRole) || Boolean(bindingError)}
                              onChange={(event) => void toggleWorkspaceSpecialist(profile, event.target.checked)}
                            />
                            <span className="min-w-0"><span className="block font-medium text-foreground">{profile.name}</span><span className="block break-words text-[10px] text-muted-foreground">{profile.specialty || profile.description || 'Available when a task matches this profile.'}</span></span>
                          </label>
                        )) : <p className="text-[10px] text-muted-foreground">Create a {profileRoleLabel(role).toLowerCase()} profile to add it to the pool.</p>}
                      </div>;
                    })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          {bindingError && <Button variant="outline" size="sm" onClick={() => void loadBindings(bindingScope, bindingScopeId)}>Retry bindings</Button>}
          </div>
          </details>
        </TabsContent>

        <TabsContent value="templates" className="space-y-4">
        <div><h2 className="text-lg font-semibold tracking-tight">Reusable teams</h2><p className="mt-1 text-sm text-muted-foreground">Templates define a set of roles. The orchestrator assigns tasks and models within that team.</p></div>
        {error && <div role="alert" className="break-words rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        {isLoading ? (
          <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading templates…</div>
        ) : (
          <div className="grid min-w-0 gap-4 xl:grid-cols-2">
            {templates.map((template) => (
              <Card key={template.id} className="min-w-0 overflow-hidden border-border/80 bg-card/70">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><CardTitle className="truncate text-base">{template.name}</CardTitle><CardDescription className="mt-1 break-words">{template.description || 'No description provided.'}</CardDescription></div>
                    <div className="flex shrink-0 items-center gap-2">
                      {template.isDefault && <Badge>Default</Badge>}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${template.name}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="z-[120]">
                          <DropdownMenuItem onClick={() => openEdit(template)}><Pencil className="h-4 w-4" />Edit template</DropdownMenuItem>
                          {!template.isDefault && <DropdownMenuItem onClick={() => void setDefault(template)} disabled={busyTemplateId === template.id}><Star className="h-4 w-4" />Set as default</DropdownMenuItem>}
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(template)} disabled={template.isDefault}><Trash2 className="h-4 w-4" />Delete template</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex flex-wrap gap-1.5">{template.roles.map((role) => <Badge key={`${template.id}-${role.role}`} variant="secondary" className="text-xs">{profileRoleLabel(role.role)}</Badge>)}</div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="outline" size="sm" onClick={() => openEdit(template)}><Pencil className="mr-2 h-4 w-4" />Edit</Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            {!templates.length && !error && <Card className="border-dashed xl:col-span-2"><CardContent className="flex min-h-40 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"><p>Save a reusable set of roles for repeat work.</p><Button size="sm" onClick={openCreate}><Plus className="mr-2 h-4 w-4" />Create team template</Button></CardContent></Card>}
          </div>
        )}
        </TabsContent>
        </Tabs>
      </div>

      <Dialog open={profileEditorOpen} onOpenChange={(open) => { if (!profileSaving) setProfileEditorOpen(open); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingProfile ? 'Edit specialist' : 'Create specialist'}</DialogTitle>
            <DialogDescription>Give your specialist a reusable brief. Start with automatic routing; fine-tune preferences when needed.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => { event.preventDefault(); void saveProfile(); }} className="space-y-4">
          <fieldset disabled={profileSaving} className="grid min-w-0 gap-4 py-2 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="agent-profile-name">Name <span className="text-muted-foreground">(required)</span></Label>
              <Input id="agent-profile-name" required value={profileDraft.name} onChange={(event) => setProfileDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Documentation specialist" autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-profile-role">Safety role</Label>
              <select id="agent-profile-role" className={SELECT_CLASS} value={profileDraft.role} disabled={Boolean(editingProfile)} onChange={(event) => setProfileDraft((current) => ({ ...current, role: event.target.value as AgentRole }))}>
                {PROFILE_ROLES.map((role) => <option key={role} value={role}>{ROLE_HELP[role]}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">Defines permitted work. Cannot change after creation.</p>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="agent-profile-specialty">Specialty <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input id="agent-profile-specialty" value={profileDraft.specialty} onChange={(event) => setProfileDraft((current) => ({ ...current, specialty: event.target.value }))} placeholder="API documentation and developer guides" />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="agent-profile-instructions">Instructions</Label>
              <textarea id="agent-profile-instructions" value={profileDraft.instructions} onChange={(event) => setProfileDraft((current) => ({ ...current, instructions: event.target.value }))} rows={5} className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20" placeholder="A short, task-focused operating brief for this role." />
            </div>
            <details className="min-w-0 rounded-xl border border-border sm:col-span-2">
              <summary className="cursor-pointer rounded-xl p-3 text-sm font-medium focus-visible:outline-ring">Advanced options <span className="ml-1 font-normal text-muted-foreground">Description, capabilities &amp; routing</span></summary>
              <div className="space-y-4 p-3 pt-0">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2"><Label htmlFor="agent-profile-description">Description</Label><Input id="agent-profile-description" value={profileDraft.description} onChange={(event) => setProfileDraft((current) => ({ ...current, description: event.target.value }))} placeholder="A short summary of this specialist" /></div>
                <div className="space-y-2"><Label htmlFor="agent-profile-capabilities">Capabilities</Label><Input id="agent-profile-capabilities" value={profileDraft.capabilities} onChange={(event) => setProfileDraft((current) => ({ ...current, capabilities: event.target.value }))} placeholder="research, documentation" /><p className="text-xs text-muted-foreground">Comma-separated labels. Permissions still follow the safety role.</p></div>
              </div>
              <div className="border-t border-border pt-3"><h3 className="text-sm font-medium">Route preference</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Availability is checked at run time. A fixed route cannot silently switch to an unrelated route.</p></div>
              {(accountError || modelCatalogError) && <div role="alert" className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"><p className="break-words">{accountError || modelCatalogError}</p><Button type="button" variant="outline" size="sm" disabled={accountLoading} onClick={() => void fetchAccounts({ refreshModels: true })}>Retry accounts &amp; models</Button></div>}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="agent-profile-selection-mode">Route mode</Label>
                  <select id="agent-profile-selection-mode" className={SELECT_CLASS} value={profileDraft.selectionMode} onChange={(event) => setProfileDraft((current) => ({ ...current, selectionMode: event.target.value as AgentProfileDraft['selectionMode'] }))}>
                    {PROFILE_SELECTION_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="agent-profile-reasoning">Reasoning</Label>
                  <select id="agent-profile-reasoning" className={SELECT_CLASS} value={profileDraft.reasoningLevel} onChange={(event) => setProfileDraft((current) => ({ ...current, reasoningLevel: event.target.value as AgentProfileDraft['reasoningLevel'] }))}>
                    <option value="">Model default</option>
                    {draftReasoningLevels.map((level) => <option key={level} value={level}>{level}</option>)}
                    {profileDraft.reasoningLevel && !draftReasoningLevels.includes(profileDraft.reasoningLevel) && <option value={profileDraft.reasoningLevel}>{profileDraft.reasoningLevel} (unsupported)</option>}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="agent-profile-account">Account preference</Label>
                  <select id="agent-profile-account" className={SELECT_CLASS} value={profileDraft.accountProfileId} onChange={(event) => setProfileDraft((current) => ({ ...current, accountProfileId: event.target.value }))}>
                    <option value="">Any compatible account</option>
                     {accounts.map((account) => <option key={account.id} value={account.id}>{account.profileName} · {account.runtimeType} · {account.authStatus.replaceAll('_', ' ')}</option>)}
                     {profileDraft.accountProfileId && !accounts.some((account) => account.id === profileDraft.accountProfileId) && <option value={profileDraft.accountProfileId}>Saved account (unavailable)</option>}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="agent-profile-model">Model preference</Label>
                  <select id="agent-profile-model" className={SELECT_CLASS} value={profileDraft.modelCatalogId} onChange={(event) => setProfileDraft((current) => ({ ...current, modelCatalogId: event.target.value }))}>
                    <option value="">Scheduler chooses a compatible model</option>
                    {draftModels.map((model) => <option key={model.catalogId} value={model.catalogId}>{model.name} · {model.accountName} · {model.available ? 'available' : 'verify at run'}</option>)}
                    {profileDraft.modelCatalogId && !draftModels.some((model) => model.catalogId === profileDraft.modelCatalogId) && <option value={profileDraft.modelCatalogId}>Saved model (unavailable or incompatible)</option>}
                  </select>
                </div>
              </div>
              {accountLoading && <p role="status" className="text-xs text-muted-foreground">Refreshing accounts and models…</p>}
              </div>
            </details>
          </fieldset>
          {(profileEditorError || (profileDraft.name.trim() && profileValidation)) && <p id="profile-editor-error" role="alert" className="break-words rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{profileEditorError || profileValidation}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={profileSaving} onClick={() => setProfileEditorOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={profileSaving || Boolean(profileValidation) || (accountLoading && Boolean(profileDraft.accountProfileId || profileDraft.modelCatalogId || profileDraft.reasoningLevel))} aria-describedby={profileEditorError || (profileDraft.name.trim() && profileValidation) ? 'profile-editor-error' : undefined}>{profileSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{editingProfile ? 'Save changes' : 'Create specialist'}</Button>
          </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(profileDeleteTarget)} onOpenChange={(open) => !open && setProfileDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Delete specialist?</DialogTitle><DialogDescription>This removes “{profileDeleteTarget?.name}” from the saved catalog. Defaults using this specialist may need reassignment. Existing mission history is kept.</DialogDescription></DialogHeader>
          {profileError && <p role="alert" className="break-words text-sm text-destructive">{profileError}</p>}
          <DialogFooter><Button variant="ghost" onClick={() => setProfileDeleteTarget(null)}>Cancel</Button><Button variant="destructive" disabled={!profileDeleteTarget || busyProfileId === profileDeleteTarget?.id} onClick={() => void deleteProfile()}>{busyProfileId === profileDeleteTarget?.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Delete specialist</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader><DialogTitle>{editingTemplate ? 'Edit team template' : 'Create team template'}</DialogTitle><DialogDescription>Choose the reusable roles AtrisAgent may schedule. Model routes can be assigned automatically or overridden from chat.</DialogDescription></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2"><Label htmlFor="team-template-name">Name</Label><Input id="team-template-name" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Frontend delivery team" /></div>
            <div className="space-y-2"><Label htmlFor="team-template-description">Description</Label><Input id="team-template-description" value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="Orchestration, implementation, review and QA" /></div>
            <div className="space-y-2"><Label>Roles</Label><div className="grid gap-2 sm:grid-cols-2">{ALL_ROLES.map((role) => {
              const config = ROLE_UI[role]; const Icon = config.icon; const selected = draft.roles.includes(role);
              return <button key={role} type="button" aria-pressed={selected} onClick={() => setDraft((current) => ({ ...current, roles: selected ? current.roles.filter((item) => item !== role) : [...current.roles, role] }))} className={cn('flex items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-ring', selected ? 'border-primary/40 bg-primary/10' : 'border-border hover:bg-muted/50')}><Icon className="h-4 w-4" /><div><div className="text-sm font-medium">{config.label}</div><div className="text-[11px] text-muted-foreground">{config.access.replaceAll('_', ' ')}</div></div></button>;
            })}</div></div>
          </div>
          {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
          <DialogFooter><Button variant="ghost" onClick={() => setEditorOpen(false)}>Cancel</Button><Button disabled={saving || !draft.name.trim() || draft.roles.length === 0} onClick={() => void saveTemplate()}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{editingTemplate ? 'Save changes' : 'Create'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Delete team template?</DialogTitle><DialogDescription>This removes “{deleteTarget?.name}” and its role configuration. Existing mission history is not deleted.</DialogDescription></DialogHeader>
          {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
          <DialogFooter><Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" disabled={!deleteTarget || busyTemplateId === deleteTarget?.id} onClick={() => void deleteTemplate()}>{busyTemplateId === deleteTarget?.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Delete template</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
