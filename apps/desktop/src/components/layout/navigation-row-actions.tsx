import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

/** The parent navigation-row reveals this action for pointer and keyboard users. */
export function NavigationRowActions({ name, onRename, onDelete, deleteLabel, renameDisabled }: { name: string; onRename?: () => void; onDelete: () => void; deleteLabel: string; renameDisabled?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={`Actions for ${name}`}
          className="navigation-row-action mr-1 h-7 w-7 shrink-0 rounded-md text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground">
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {onRename && <><DropdownMenuItem disabled={renameDisabled} onSelect={onRename}><Pencil className="h-3.5 w-3.5" />Rename…</DropdownMenuItem><DropdownMenuSeparator /></>}
        <DropdownMenuItem variant="destructive" onSelect={onDelete}><Trash2 className="h-3.5 w-3.5" />{deleteLabel}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
