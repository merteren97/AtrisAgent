import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useWorkspaceStore } from '../../stores/workspace-store';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { FolderOpen, Loader2, GitBranch, AlertCircle, CheckCircle2, Pencil } from 'lucide-react';

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface WorkspaceInspection {
  path: string;
  name: string;
  isGit: boolean;
  gitRoot?: string | null;
  branch?: string | null;
  dirty: boolean;
  projectTypes: string[];
}

function folderName(value: string): string {
  const clean = value.trim().replace(/[/\\]+$/, '');
  return clean.split(/[/\\]/).pop() || 'Workspace';
}

export function CreateWorkspaceDialog({ open, onOpenChange }: CreateWorkspaceDialogProps) {
  const { createWorkspace } = useWorkspaceStore();
  const [path, setPath] = useState('');
  const [inspection, setInspection] = useState<WorkspaceInspection | null>(null);
  const [customName, setCustomName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [isInspecting, setIsInspecting] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPath('');
    setInspection(null);
    setCustomName('');
    setEditingName(false);
    setError(null);
    setIsInspecting(false);
    setIsOpening(false);
  };

  const inspectPath = async (candidate: string) => {
    const trimmed = candidate.trim();
    if (!trimmed) return;
    setIsInspecting(true);
    setError(null);
    try {
      const result = await invoke<WorkspaceInspection>('inspect_workspace_path', { path: trimmed });
      setInspection(result);
      setPath(result.path);
      setCustomName(result.name);
    } catch (err: any) {
      setInspection(null);
      setCustomName(folderName(trimmed));
      setError(typeof err === 'string' ? err : err?.message || 'Could not inspect this project folder.');
    } finally {
      setIsInspecting(false);
    }
  };

  const handleSelectFolder = async () => {
    setError(null);
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: 'Open project folder' });
      if (!selected) return;
      const selectedPath = Array.isArray(selected) ? selected[0] : selected;
      if (selectedPath) await inspectPath(String(selectedPath));
    } catch (err: any) {
      setError(err?.message || 'The native folder picker could not be opened.');
    }
  };

  const handleOpen = async () => {
    if (!inspection) {
      await inspectPath(path);
      return;
    }
    setIsOpening(true);
    setError(null);
    try {
      const workspace = await createWorkspace(
        (customName || inspection.name).trim(),
        inspection.path,
        inspection.isGit,
      );
      if (!workspace) throw new Error(useWorkspaceStore.getState().error || 'Workspace could not be opened.');
      onOpenChange(false);
      reset();
    } catch (err: any) {
      setError(err?.message || 'Workspace could not be opened.');
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (!value) reset();
      }}
    >
      <DialogContent className="sm:max-w-[520px] border-border bg-card shadow-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <FolderOpen className="h-4 w-4 text-primary" />
            Open project
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Choose a local project folder. AtrisAgent will inspect the repository and remember it as a workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <button
            type="button"
            onClick={() => void handleSelectFolder()}
            className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border bg-muted/15 p-4 text-left transition-colors hover:border-primary/50 hover:bg-primary/[0.03]"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
              {isInspecting ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <FolderOpen className="h-4 w-4 text-primary" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{inspection ? 'Choose a different folder' : 'Choose project folder'}</span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                {inspection?.path || path || 'Browse your local filesystem'}
              </span>
            </span>
          </button>

          {!inspection && (
            <div className="flex items-center gap-2">
              <Input
                value={path}
                onChange={(event) => { setPath(event.target.value); setError(null); }}
                onKeyDown={(event) => { if (event.key === 'Enter') void inspectPath(path); }}
                placeholder="Or paste an absolute project path…"
                className="h-9 bg-background font-mono text-[11px]"
              />
              <Button variant="outline" size="sm" className="h-9" disabled={!path.trim() || isInspecting} onClick={() => void inspectPath(path)}>
                Inspect
              </Button>
            </div>
          )}

          {inspection && (
            <div className="overflow-hidden rounded-xl border border-border bg-background/60">
              <div className="flex items-start gap-3 border-b border-border px-4 py-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <FolderOpen className="h-4 w-4 text-primary" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {editingName ? (
                      <Input
                        autoFocus
                        value={customName}
                        onChange={(event) => setCustomName(event.target.value)}
                        onBlur={() => setEditingName(false)}
                        onKeyDown={(event) => { if (event.key === 'Enter') setEditingName(false); }}
                        className="h-7 max-w-[260px] text-xs font-semibold"
                      />
                    ) : (
                      <span className="truncate text-sm font-semibold">{customName || inspection.name}</span>
                    )}
                    {!editingName && (
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={() => setEditingName(true)}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{inspection.path}</p>
                </div>
              </div>

              <div className="space-y-2 px-4 py-3 text-[11px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-muted-foreground"><GitBranch className="h-3.5 w-3.5" />Git</span>
                  {inspection.isGit ? (
                    <span className="flex items-center gap-2">
                      <Badge variant="outline" className="h-5 px-1.5 text-[9px]">{inspection.branch || 'detached HEAD'}</Badge>
                      <span className={inspection.dirty ? 'text-amber-400' : 'text-emerald-400'}>{inspection.dirty ? 'Changes present' : 'Clean'}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Not a Git repository</span>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Detected stack</span>
                  <div className="flex flex-wrap justify-end gap-1">
                    {inspection.projectTypes.length > 0
                      ? inspection.projectTypes.map((type) => <Badge key={type} variant="secondary" className="h-5 px-1.5 text-[9px]">{type}</Badge>)
                      : <span className="text-muted-foreground">Generic project</span>}
                  </div>
                </div>

                {inspection.isGit && inspection.gitRoot && inspection.gitRoot !== inspection.path && (
                  <div className="rounded-md bg-muted/30 px-2.5 py-2 text-[10px] text-muted-foreground">
                    <CheckCircle2 className="mr-1 inline h-3 w-3 text-emerald-400" />
                    This folder is inside the Git repository at <span className="font-mono">{inspection.gitRoot}</span>.
                  </div>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isOpening}>Cancel</Button>
          <Button size="sm" onClick={() => void handleOpen()} disabled={isOpening || isInspecting || (!inspection && !path.trim())}>
            {isOpening && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {inspection ? 'Open workspace' : 'Inspect folder'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
