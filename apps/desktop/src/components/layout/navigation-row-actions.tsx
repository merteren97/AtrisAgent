import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** The parent navigation-row reveals this action for pointer and keyboard users. */
export function NavigationDeleteAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={label}
          className="navigation-row-action mr-1 h-7 w-7 shrink-0 rounded-md text-sidebar-muted hover:bg-destructive/10 hover:text-destructive"
          onClick={(event) => { event.stopPropagation(); onClick(); }}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
