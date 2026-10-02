import { useEffect, useState } from 'react';
import { Users, ChevronDown, Check, AlertCircle, Loader2, Settings2, RefreshCw } from 'lucide-react';
import type { TeamTemplate } from '@atris-agent-code/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings-store';
import { apiRequest } from '@/lib/api-client';
import { useOrchestratorPreferences } from '@/stores/orchestrator-preferences-store';
import {
  isCoreDevTeam,
  normalizeTeamTemplates,
  reconcileTeamTemplateId,
} from '@/lib/team-template-utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function TeamTemplateSelector() {
  const { preferences, updatePreferences, scopeKey } = useOrchestratorPreferences();
  const teamTemplate = preferences.teamTemplate;
  const setActiveView = useSettingsStore((state) => state.setActiveView);
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    apiRequest<TeamTemplate[]>('/team-templates')
      .then((items) => {
        if (cancelled) return;
        setTemplates(normalizeTeamTemplates(items));
        const reconciledId = reconcileTeamTemplateId(items, teamTemplate);
        if (reconciledId !== teamTemplate) updatePreferences({ teamTemplate: reconciledId });
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Team templates could not be loaded.');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [refresh, updatePreferences, scopeKey, teamTemplate]);

  const selected = templates.find((template) => template.id === teamTemplate);
  const selectedLabel = selected?.name
    || (isLoading ? 'Loading…' : error ? 'Unavailable' : 'Default roles');

  return (
    <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (next) setRefresh((current) => current + 1); }}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 max-w-[190px] gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          aria-label={`Reusable team template: ${selectedLabel}`}
          title={selectedLabel}
        >
          {isLoading
            ? <Loader2 className="h-3 w-3 animate-spin text-primary" aria-hidden="true" />
            : error
              ? <AlertCircle className="h-3 w-3 text-destructive" aria-hidden="true" />
              : <Users className="h-3 w-3" aria-hidden="true" />}
          <span className="truncate">Template: {selectedLabel}</span>
          <ChevronDown className="h-2.5 w-2.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(320px,calc(100vw-2rem))] text-xs">
        <DropdownMenuLabel className="text-xs">Reusable team template</DropdownMenuLabel>
        <p className="px-2 pb-2 text-xs leading-relaxed text-muted-foreground">A template defines roles. Automatic team selection assigns specialists to the work.</p>
        <div className="max-h-72 overflow-y-auto">
        {templates.map((template) => (
            <DropdownMenuItem
              key={template.id}
              onClick={() => updatePreferences({ teamTemplate: template.id })}
              disabled={isLoading || Boolean(error)}
              className="flex flex-col items-start gap-1 p-2"
            >
              <div className="flex w-full min-w-0 items-center gap-2 font-medium">
                <span className="min-w-0 flex-1 truncate">{template.name}</span>
                {isCoreDevTeam(template) && <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[8px]">Core</Badge>}
                {!isCoreDevTeam(template) && template.isDefault && <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[8px]">Default</Badge>}
                {teamTemplate === template.id && <Check className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />}
              </div>
              <span className="text-[10px] text-muted-foreground">{template.description || `${template.roles.length} configured roles`}</span>
            </DropdownMenuItem>
        ))}
        </div>
        {(isLoading || error || !templates.length) && (
          <div className="flex items-start gap-2 px-2 py-2 text-xs text-muted-foreground" role={error ? 'alert' : 'status'}>
            {isLoading && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
            {error && <AlertCircle className="h-3 w-3 shrink-0 text-destructive" aria-hidden="true" />}
            <span className={error ? 'min-w-0 break-words text-destructive' : undefined}>{isLoading ? 'Loading team templates…' : error || 'No saved templates. Built-in role defaults remain available.'}</span>
          </div>
        )}
        {error && <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setRefresh((current) => current + 1); }}><RefreshCw className="h-4 w-4" />Retry templates</DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setActiveView('agents')}><Settings2 className="h-4 w-4" />Manage teams &amp; specialists</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
