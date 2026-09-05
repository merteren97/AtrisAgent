import { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import type { AccountProfile, AgentRole, CanonicalReasoning, TeamTemplate, TeamRole } from '@atris-agent-code/domain';
import { apiRequest } from '@/lib/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
export function toAgentProfilePayload(draft: AgentProfileDraft, includeRole = true): Record<string, unknown> {
  const routePolicy: DesktopAgentProfileRoutePolicy = {
    selectionMode: draft.selectionMode,
    ...(draft.accountProfileId.trim() ? { accountProfileId: draft.accountProfileId.trim() } : {}),
    ...(draft.modelCatalogId.trim() ? { modelCatalogId: draft.modelCatalogId.trim() } : {}),
    ...(draft.reasoningLevel ? { reasoningLevel: draft.reasoningLevel } : {}),
  };
  const hasRoutePolicy = Object.keys(routePolicy).some((key) => key !== 'selectionMode' || routePolicy.selectionMode !== 'auto');
  return {
    ...(includeRole ? { role: draft.role } : {}),
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    ...(draft.specialty.trim() ? { specialty: draft.specialty.trim() } : {}),
    instructions: draft.instructions.trim(),
    capabilities: normalizedCapabilities(draft.capabilities),
    ...(hasRoutePolicy ? { routePolicy } : {}),
  };
}

function modelSupportsProfileRole(model: DesktopDiscoveredModel, role: AgentRole): boolean {
  return model.suitableRoles.length === 0 || model.suitableRoles.some((candidate) => candidate.toLowerCase() === role);
}

function profileRouteSummary(profile: DesktopAgentProfile, accounts: AccountProfile[], models: DesktopDiscoveredModel[]): string {
  const route = profile.routePolicy;
  if (!route || route.selectionMode === 'auto') return 'Auto route · scheduler chooses a compatible connected model';
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
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);
  const accounts = useAccountStore((state) => state.accounts);
  const discoveredModels = useAccountStore((state) => state.discoveredModels);
  const fetchAccounts = useAccountStore((state) => state.fetchAccounts);
  const profilesByRole = useMemo(() => new Map(
    PROFILE_ROLES.map((role) => [role, profiles.filter((profile) => profile.role === role)] as const),
  ), [profiles]);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [bindingScope, setBindingScope] = useState<ProfileBindingScope>('global');
  const [bindingScopeId, setBindingScopeId] = useState('global');
  const [bindings, setBindings] = useState<Partial<Record<AgentRole, string>>>({});
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [bindingBusyRole, setBindingBusyRole] = useState<AgentRole | null>(null);

  const loadBindings = async (scope: ProfileBindingScope, scopeId: string) => {
    if (!scopeId) { setBindings({}); return; }
    setBindingsLoading(true);
    try {
      const rows = await apiRequest<unknown>(`/agent-profiles/bindings?scopeType=${encodeURIComponent(scope)}&scopeId=${encodeURIComponent(scopeId)}`);
      const next: Partial<Record<AgentRole, string>> = {};
      if (Array.isArray(rows)) rows.forEach((row) => {
        if (!row || typeof row !== 'object') return;
        const record = row as Record<string, unknown>;
        const role = typeof record.role === 'string' ? record.role.toLowerCase() as AgentRole : null;
        const profileId = typeof record.profileId === 'string' ? record.profileId : typeof record.agentProfileId === 'string' ? record.agentProfileId : '';
        if (role && PROFILE_ROLES.includes(role) && profileId && record.isDefault === true) next[role] = profileId;
      });
      setBindings(next);
    } catch {
      setBindings({});
    } finally { setBindingsLoading(false); }
  };

  useEffect(() => {
    const nextId = bindingScope === 'global' ? 'global' : bindingScope === 'workspace' ? (activeWorkspaceId || '') : (templates[0]?.id || '');
    setBindingScopeId(nextId);
    void loadBindings(bindingScope, nextId);
  }, [bindingScope, activeWorkspaceId, templates]);

  const saveBinding = async (role: AgentRole, profileId: string) => {
    if (!bindingScopeId) return;
    setBindingBusyRole(role);
    try {
      if (profileId) {
        await apiRequest('/agent-profiles/bindings', { method: 'PUT', body: JSON.stringify({ scopeType: bindingScope, scopeId: bindingScopeId, role, profileId, isDefault: true }) });
      } else {
        await apiRequest(`/agent-profiles/bindings?scopeType=${encodeURIComponent(bindingScope)}&scopeId=${encodeURIComponent(bindingScopeId)}&role=${encodeURIComponent(role)}`, { method: 'DELETE' });
      }
      setBindings((current) => ({ ...current, [role]: profileId || undefined }));
    } catch (cause: any) {
      setProfileError(cause?.message || 'Profile default could not be saved.');
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
    setEditingTemplate(null);
    setDraft(draftFromTemplate());
    setEditorOpen(true);
  };

  const openEdit = (template: TeamTemplate) => {
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
        roles: rolesFromDraft(draft.roles),
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
    setEditingProfile(null);
    setProfileDraft(emptyAgentProfileDraft());
    setProfileEditorOpen(true);
  };

  const openEditProfile = (profile: DesktopAgentProfile) => {
    setEditingProfile(profile);
    setProfileDraft(profileDraftFrom(profile));
    setProfileEditorOpen(true);
  };

  const saveProfile = async () => {
    if (!profileDraft.name.trim()) return;
    setProfileSaving(true);
    setProfileError(null);
    try {
      const editing = Boolean(editingProfile);
      const path = editing
        ? `/agent-profiles/${encodeURIComponent(editingProfile!.id)}`
        : '/agent-profiles';
      await apiRequest(path, {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify(toAgentProfilePayload(profileDraft, !editing)),
      });
      setProfileEditorOpen(false);
      await loadProfiles();
    } catch (cause: any) {
      setProfileError(cause?.message || 'Profile save failed.');
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
    } catch (cause: any) {
      setProfileError(cause?.message || 'Profile deletion failed.');
    } finally {
      setBusyProfileId(null);
    }
  };

  return (
    <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-background p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-6 pb-10">
        <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Agents &amp; Profiles</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Named profiles keep role identity, instructions and safe route preferences together. Fixed roles and account credentials stay managed by the runtime.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={isLoading || profileLoading} onClick={() => { void loadTemplates(); void loadProfiles(); }}><RefreshCw className={cn('mr-2 h-4 w-4', (isLoading || profileLoading) && 'animate-spin')} />Refresh</Button>
            <Button size="sm" onClick={openCreateProfile}><Plus className="mr-2 h-4 w-4" />New profile</Button>
            <Button size="sm" onClick={openCreate}><Plus className="mr-2 h-4 w-4" />New template</Button>
          </div>
        </div>

        {error && <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
        {profileError && <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />Named profiles are unavailable right now; runtime defaults remain active.</div>}

        <section aria-labelledby="named-profiles-heading" className="space-y-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="named-profiles-heading" className="text-lg font-semibold tracking-tight">Named profiles</h2>
              <p className="text-sm text-muted-foreground">Select a profile per fixed role in Run settings. Empty roles use the durable default.</p>
            </div>
            <Badge variant="outline" className="w-fit text-[10px]">{profiles.length} saved</Badge>
          </div>
          {profileLoading ? (
            <div className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading named profiles…</div>
          ) : (
            <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {PROFILE_ROLES.map((role) => {
                const config = ROLE_UI[role];
                const Icon = config.icon;
                const roleProfiles = profilesByRole.get(role) || [];
                return (
                  <Card key={role} className="min-w-0 border-border/80 bg-card/70">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border', config.badgeColor)}><Icon className="h-4 w-4" /></div>
                          <div className="min-w-0"><CardTitle className="text-sm">{config.label}</CardTitle><CardDescription className="mt-0.5 text-[11px]">{config.access.replaceAll('_', ' ')} boundary</CardDescription></div>
                        </div>
                        <Badge variant="outline" className="shrink-0 text-[10px]">{roleProfiles.length}</Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {roleProfiles.map((profile) => (
                        <div key={profile.id} className="min-w-0 rounded-xl border border-border/70 bg-muted/20 p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">{profile.name}</div>
                              {(profile.specialty || profile.description) && <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{profile.specialty || profile.description}</p>}
                            </div>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={`Actions for ${profile.name}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="z-[120]">
                                <DropdownMenuItem onClick={() => openEditProfile(profile)}><Pencil className="h-4 w-4" />Edit profile</DropdownMenuItem>
                                <DropdownMenuItem variant="destructive" onClick={() => setProfileDeleteTarget(profile)} disabled={busyProfileId === profile.id}><Trash2 className="h-4 w-4" />Delete profile</DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                          {profile.capabilities.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{profile.capabilities.slice(0, 6).map((capability) => <Badge key={capability} variant="outline" className="text-[9px]">{capability}</Badge>)}</div>}
                          <div className="mt-2 flex min-w-0 items-start gap-1.5 text-[10px] text-muted-foreground"><Route className="mt-0.5 h-3 w-3 shrink-0" /><span className="break-words">{profileRouteSummary(profile, accounts, discoveredModels)}</span></div>
                          <div className="mt-2 flex justify-end gap-1.5"><Button variant="outline" size="sm" className="h-7 px-2 text-[10px]" onClick={() => openEditProfile(profile)}><Pencil className="mr-1 h-3 w-3" />Edit</Button><Button variant="ghost" size="sm" className="h-7 px-2 text-[10px] text-rose-400" disabled={busyProfileId === profile.id} onClick={() => setProfileDeleteTarget(profile)}><Trash2 className="mr-1 h-3 w-3" />Delete</Button></div>
                        </div>
                      ))}
                      {!roleProfiles.length && <div className="rounded-xl border border-dashed border-border/80 px-3 py-4 text-center text-[11px] text-muted-foreground">No named profile. The {profileRoleLabel(role)} default remains active.</div>}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        <section aria-labelledby="profile-defaults-heading" className="space-y-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="profile-defaults-heading" className="text-lg font-semibold tracking-tight">Role defaults</h2>
              <p className="text-sm text-muted-foreground">Bind reusable profiles at global, workspace, or team-template scope. Explicit run selections still take precedence.</p>
            </div>
            {bindingsLoading && <Badge variant="outline" className="w-fit text-[10px]"><Loader2 className="mr-1 h-3 w-3 animate-spin" />Loading</Badge>}
          </div>
          <Card className="border-border/80 bg-card/70">
            <CardContent className="space-y-4 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="profile-binding-scope">Default scope</Label>
                  <select id="profile-binding-scope" className={SELECT_CLASS} value={bindingScope} onChange={(event) => setBindingScope(event.target.value as ProfileBindingScope)}>
                    <option value="global">Global defaults</option>
                    <option value="workspace">This workspace</option>
                    <option value="team_template">Team template</option>
                  </select>
                </div>
                {bindingScope === 'workspace' ? (
                  <div className="space-y-2"><Label htmlFor="profile-binding-workspace">Workspace</Label><select id="profile-binding-workspace" className={SELECT_CLASS} value={bindingScopeId} onChange={(event) => { setBindingScopeId(event.target.value); void loadBindings('workspace', event.target.value); }}><option value="">Choose a workspace</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></div>
                ) : bindingScope === 'team_template' ? (
                  <div className="space-y-2"><Label htmlFor="profile-binding-template">Team template</Label><select id="profile-binding-template" className={SELECT_CLASS} value={bindingScopeId} onChange={(event) => { setBindingScopeId(event.target.value); void loadBindings('team_template', event.target.value); }}><option value="">Choose a team template</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></div>
                ) : <div className="flex items-end text-[11px] text-muted-foreground">Applies when no workspace or team-template default exists.</div>}
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {PROFILE_ROLES.map((role) => {
                  const roleProfiles = profilesByRole.get(role) || [];
                  return <div key={`binding-${role}`} className="space-y-1.5 rounded-xl border border-border/70 bg-muted/20 p-3">
                    <Label htmlFor={`binding-${role}`} className="text-xs">{profileRoleLabel(role)} default</Label>
                    <select id={`binding-${role}`} className={SELECT_CLASS} disabled={!bindingScopeId || bindingBusyRole === role} value={bindings[role] || ''} onChange={(event) => void saveBinding(role, event.target.value)}>
                      <option value="">Runtime role default</option>
                      {roleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                    </select>
                    <p className="text-[10px] text-muted-foreground">{roleProfiles.length ? 'Fixed role is validated by the service.' : 'Create a profile for this role first.'}</p>
                  </div>;
                })}
              </div>
            </CardContent>
          </Card>
        </section>

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
                        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
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
                  {template.roles.map((role) => {
                    const config = ROLE_UI[role.role]; const Icon = config?.icon || Brain;
                    return (
                      <div key={`${template.id}-${role.role}`} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/20 p-3">
                        <div className="flex min-w-0 items-center gap-3"><div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border', config?.badgeColor)}><Icon className="h-4 w-4" /></div><div className="min-w-0"><div className="text-sm font-medium">{config?.label || role.role}</div><div className="truncate text-[11px] text-muted-foreground">{role.defaultCapabilities.join(' · ') || 'No explicit capabilities'}</div></div></div>
                        <Badge variant="outline" className="shrink-0 text-[10px]">{role.accessLevel.replaceAll('_', ' ')}</Badge>
                      </div>
                    );
                  })}
                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="outline" size="sm" onClick={() => openEdit(template)}><Pencil className="mr-2 h-4 w-4" />Edit</Button>
                    <Button variant="ghost" size="sm" className="text-rose-400" disabled={template.isDefault} onClick={() => setDeleteTarget(template)}><Trash2 className="mr-2 h-4 w-4" />Delete</Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            {!templates.length && <Card className="border-dashed xl:col-span-2"><CardContent className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">No templates are stored. Create the first team template.</CardContent></Card>}
          </div>
        )}
      </div>

      <Dialog open={profileEditorOpen} onOpenChange={setProfileEditorOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingProfile ? 'Edit named profile' : 'Create named profile'}</DialogTitle>
            <DialogDescription>Profiles store safe instructions, capabilities and route preferences. Credentials stay in Accounts, and the fixed role cannot be changed after creation.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="agent-profile-name">Name</Label>
              <Input id="agent-profile-name" value={profileDraft.name} onChange={(event) => setProfileDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Frontend specialist" autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-profile-role">Fixed role</Label>
              <select id="agent-profile-role" className={SELECT_CLASS} value={profileDraft.role} disabled={Boolean(editingProfile)} onChange={(event) => setProfileDraft((current) => ({ ...current, role: event.target.value as AgentRole }))}>
                {PROFILE_ROLES.map((role) => <option key={role} value={role}>{profileRoleLabel(role)}</option>)}
              </select>
              <p className="text-[10px] text-muted-foreground">Role boundaries are fixed for safety.</p>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="agent-profile-description">Description</Label>
              <Input id="agent-profile-description" value={profileDraft.description} onChange={(event) => setProfileDraft((current) => ({ ...current, description: event.target.value }))} placeholder="Keeps UI work consistent and reviewable" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-profile-specialty">Specialty <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input id="agent-profile-specialty" value={profileDraft.specialty} onChange={(event) => setProfileDraft((current) => ({ ...current, specialty: event.target.value }))} placeholder="React and accessibility" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-profile-capabilities">Capabilities</Label>
              <Input id="agent-profile-capabilities" value={profileDraft.capabilities} onChange={(event) => setProfileDraft((current) => ({ ...current, capabilities: event.target.value }))} placeholder="workspace-write, run-command" />
              <p className="text-[10px] text-muted-foreground">Comma-separated labels; runtime permissions remain authoritative.</p>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="agent-profile-instructions">Instructions</Label>
              <textarea id="agent-profile-instructions" value={profileDraft.instructions} onChange={(event) => setProfileDraft((current) => ({ ...current, instructions: event.target.value }))} rows={5} className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20" placeholder="A short, task-focused operating brief for this role." />
            </div>
            <div className="space-y-3 rounded-xl border border-border/80 bg-muted/20 p-3 sm:col-span-2">
              <div className="flex items-start gap-2"><Route className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><div><div className="text-sm font-medium">Safe route preference</div><p className="text-[10px] leading-relaxed text-muted-foreground">Only account and model references are saved here. Availability is checked again when a mission runs.</p></div></div>
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
                    {PROFILE_REASONING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="agent-profile-account">Account preference</Label>
                  <select id="agent-profile-account" className={SELECT_CLASS} value={profileDraft.accountProfileId} onChange={(event) => setProfileDraft((current) => ({ ...current, accountProfileId: event.target.value }))}>
                    <option value="">Any compatible account</option>
                    {accounts.map((account) => <option key={account.id} value={account.id}>{account.profileName} · {account.runtimeType} · {account.authStatus.replaceAll('_', ' ')}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="agent-profile-model">Model preference</Label>
                  <select id="agent-profile-model" className={SELECT_CLASS} value={profileDraft.modelCatalogId} onChange={(event) => setProfileDraft((current) => ({ ...current, modelCatalogId: event.target.value }))}>
                    <option value="">Scheduler chooses a compatible model</option>
                    {discoveredModels.filter((model) => modelSupportsProfileRole(model, profileDraft.role)).map((model) => <option key={model.catalogId} value={model.catalogId}>{model.name} · {model.accountName} · {model.available ? 'available' : 'verify at run'}</option>)}
                    {profileDraft.modelCatalogId && !discoveredModels.some((model) => model.catalogId === profileDraft.modelCatalogId) && <option value={profileDraft.modelCatalogId}>Saved model (not currently discovered)</option>}
                  </select>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setProfileEditorOpen(false)}>Cancel</Button>
            <Button disabled={profileSaving || !profileDraft.name.trim()} onClick={() => void saveProfile()}>{profileSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{editingProfile ? 'Save changes' : 'Create profile'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(profileDeleteTarget)} onOpenChange={(open) => !open && setProfileDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Delete named profile?</DialogTitle><DialogDescription>This removes “{profileDeleteTarget?.name}”. The fixed {profileDeleteTarget ? profileRoleLabel(profileDeleteTarget.role) : 'role'} default and existing mission history are unchanged.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="ghost" onClick={() => setProfileDeleteTarget(null)}>Cancel</Button><Button variant="destructive" disabled={!profileDeleteTarget || busyProfileId === profileDeleteTarget?.id} onClick={() => void deleteProfile()}>{busyProfileId === profileDeleteTarget?.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Delete profile</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{editingTemplate ? 'Edit team template' : 'Create team template'}</DialogTitle><DialogDescription>Choose the reusable roles AtrisAgent may schedule. Model routes can be assigned automatically or overridden from chat.</DialogDescription></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2"><Label>Name</Label><Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Frontend delivery team" /></div>
            <div className="space-y-2"><Label>Description</Label><Input value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="Orchestration, implementation, review and QA" /></div>
            <div className="space-y-2"><Label>Roles</Label><div className="grid gap-2 sm:grid-cols-2">{ALL_ROLES.map((role) => {
              const config = ROLE_UI[role]; const Icon = config.icon; const selected = draft.roles.includes(role);
              return <button key={role} type="button" onClick={() => setDraft((current) => ({ ...current, roles: selected ? current.roles.filter((item) => item !== role) : [...current.roles, role] }))} className={cn('flex items-center gap-3 rounded-xl border p-3 text-left transition-colors', selected ? 'border-primary/40 bg-primary/10' : 'border-border hover:bg-muted/50')}><Icon className="h-4 w-4" /><div><div className="text-sm font-medium">{config.label}</div><div className="text-[11px] text-muted-foreground">{config.access.replaceAll('_', ' ')}</div></div></button>;
            })}</div></div>
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setEditorOpen(false)}>Cancel</Button><Button disabled={saving || !draft.name.trim() || draft.roles.length === 0} onClick={() => void saveTemplate()}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{editingTemplate ? 'Save changes' : 'Create'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Delete team template?</DialogTitle><DialogDescription>This removes “{deleteTarget?.name}” and its role configuration. Existing mission history is not deleted.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" disabled={!deleteTarget || busyTemplateId === deleteTarget?.id} onClick={() => void deleteTemplate()}>{busyTemplateId === deleteTarget?.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Delete template</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
