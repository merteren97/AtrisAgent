import { useEffect, useState } from 'react';
import { Users, ChevronDown, Check, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings-store';
import { apiRequest } from '@/lib/api-client';
import type { TeamTemplate } from '@atris-agent-code/domain';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function TeamTemplateSelector() {
  const { teamTemplate, setTeamTemplate } = useSettingsStore();
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    apiRequest<TeamTemplate[]>('/team-templates')
      .then((items) => { setTemplates(items); setLoadFailed(false); })
      .catch(() => { setTemplates([]); setLoadFailed(true); });
  }, []);

  const selected = templates.find((template) => template.id === teamTemplate);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 gap-1 text-[10px] text-muted-foreground hover:text-foreground">
          {loadFailed ? <AlertCircle className="h-3 w-3 text-amber-400" /> : <Users className="h-3 w-3" />}
          {selected?.name || (loadFailed ? 'Templates unavailable' : 'Core Dev Team')}
          <ChevronDown className="h-2.5 w-2.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 text-xs">
        {templates.map((template) => (
          <DropdownMenuItem
            key={template.id}
            onClick={() => setTeamTemplate(template.id)}
            className="flex flex-col items-start gap-1 p-2"
          >
            <div className="flex w-full items-center justify-between font-medium">
              {template.name}
              {teamTemplate === template.id && <Check className="h-3 w-3 text-primary" />}
            </div>
            <span className="text-[10px] text-muted-foreground">{template.description || `${template.roles.length} configured roles`}</span>
          </DropdownMenuItem>
        ))}
        {!templates.length && <div className="px-3 py-2 text-[11px] text-muted-foreground">No templates are available from the local service.</div>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
