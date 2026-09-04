import { Fragment, useEffect, useState } from 'react';
import { Users, ChevronDown, Check, AlertCircle, Loader2 } from 'lucide-react';
import type { TeamTemplate } from '@atris-agent-code/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings-store';
import { apiRequest } from '@/lib/api-client';
import {
  CORE_DEV_TEAM_NAME,
  DEFAULT_TEAM_TEMPLATE_ID,
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
  const teamTemplate = useSettingsStore((state) => state.teamTemplate);
  const setTeamTemplate = useSettingsStore((state) => state.setTeamTemplate);
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    apiRequest<TeamTemplate[]>('/team-templates')
      .then((items) => {
        if (cancelled) return;
        setTemplates(normalizeTeamTemplates(items));
        const currentId = useSettingsStore.getState().teamTemplate;
        const reconciledId = reconcileTeamTemplateId(items, currentId);
        if (reconciledId !== currentId) setTeamTemplate(reconciledId);
        setLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) {
          setTemplates([]);
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [setTeamTemplate]);

  const selected = templates.find((template) => template.id === teamTemplate);
  const selectedLabel = selected?.name
    || (teamTemplate === DEFAULT_TEAM_TEMPLATE_ID ? CORE_DEV_TEAM_NAME : undefined)
    || (isLoading ? 'Loading teams…' : loadFailed ? 'Templates unavailable' : 'Select a team');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 max-w-[190px] gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          aria-label={`Select mission team: ${selectedLabel}`}
          title={selectedLabel}
        >
          {isLoading
            ? <Loader2 className="h-3 w-3 animate-spin text-primary" aria-hidden="true" />
            : loadFailed
              ? <AlertCircle className="h-3 w-3 text-amber-400" aria-hidden="true" />
              : <Users className="h-3 w-3" aria-hidden="true" />}
          <span className="truncate">{selectedLabel}</span>
          <ChevronDown className="h-2.5 w-2.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 text-xs">
        <DropdownMenuLabel className="px-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Mission team</DropdownMenuLabel>
        {templates.map((template, index) => (
          <Fragment key={template.id}>
            {index === 1 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onClick={() => setTeamTemplate(template.id)}
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
          </Fragment>
        ))}
        {!templates.length && (
          <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground" role={loadFailed ? 'alert' : undefined}>
            {isLoading && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
            {loadFailed && <AlertCircle className="h-3 w-3 text-amber-400" aria-hidden="true" />}
            {isLoading ? 'Loading team templates…' : loadFailed ? 'Team templates are unavailable.' : 'No templates are available from the local service.'}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
