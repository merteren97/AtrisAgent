import { useEffect, useState } from 'react';
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
} from 'lucide-react';
import type { AgentRole, TeamTemplate, TeamRole } from '@atris-agent-code/domain';
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
import { cn } from '@/lib/utils';

const ROLE_UI: Record<AgentRole, { icon: typeof Brain; badgeColor: string; label: string; access: TeamRole['accessLevel']; capabilities: string[] }> = {
  orchestrator: { icon: Brain, badgeColor: 'bg-purple-500/10 text-purple-400 border-purple-500/20', label: 'Orchestrator', access: 'orchestration', capabilities: ['planning', 'delegation', 'evaluation'] },
  builder: { icon: Wrench, badgeColor: 'bg-green-500/10 text-green-400 border-green-500/20', label: 'Builder', access: 'write', capabilities: ['workspace-write', 'run-command'] },
  reviewer: { icon: Eye, badgeColor: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20', label: 'Reviewer', access: 'read', capabilities: ['code-review', 'security-review'] },
  researcher: { icon: Search, badgeColor: 'bg-blue-500/10 text-blue-400 border-blue-500/20', label: 'Researcher', access: 'read', capabilities: ['research', 'documentation'] },
  qa: { icon: Shield, badgeColor: 'bg-orange-500/10 text-orange-400 border-orange-500/20', label: 'QA', access: 'tests_and_build', capabilities: ['build', 'test', 'lint'] },
};
const ALL_ROLES = Object.keys(ROLE_UI) as AgentRole[];

type TemplateDraft = { name: string; description: string; roles: AgentRole[] };

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

  const loadTemplates = async () => {
    setIsLoading(true);
    setError(null);
    try {
      setTemplates(await apiRequest<TeamTemplate[]>('/team-templates'));
    } catch (cause: any) {
      setTemplates([]);
      setError(cause?.message || 'Team templates could not be loaded from the local service.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { void loadTemplates(); }, []);

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

  return (
    <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-background p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-6 pb-10">
        <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Team Templates & Agent Roles</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Templates define allowed roles and access boundaries. You can edit, delete and choose the default template. A mission may still spawn an explicitly requested connected model directly from chat.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={isLoading} onClick={() => void loadTemplates()}><RefreshCw className={cn('mr-2 h-4 w-4', isLoading && 'animate-spin')} />Refresh</Button>
            <Button size="sm" onClick={openCreate}><Plus className="mr-2 h-4 w-4" />New template</Button>
          </div>
        </div>

        {error && <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}

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
