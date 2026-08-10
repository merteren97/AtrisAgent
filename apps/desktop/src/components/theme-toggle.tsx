import { Laptop, Moon, Sun, ChevronDown } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const OPTIONS = [
  { id: 'system', label: 'System', icon: Laptop },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
] as const;

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme = 'system', setTheme } = useTheme();
  const selected = OPTIONS.find((option) => option.id === theme) || OPTIONS[0];
  const Icon = selected.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={compact ? 'icon' : 'sm'}
          className={compact ? 'relative h-7 w-7' : 'h-9 min-w-28 justify-between gap-2'}
          aria-label={`Theme: ${selected.label}`}
        >
          <span className="flex items-center gap-2">
            <Icon className="h-4 w-4" />
            {!compact && <span>{selected.label}</span>}
          </span>
          {!compact && <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[120] min-w-36">
        {OPTIONS.map((option) => {
          const OptionIcon = option.icon;
          return (
            <DropdownMenuItem key={option.id} onClick={() => setTheme(option.id)} className="cursor-pointer">
              <OptionIcon className="h-4 w-4" />
              <span>{option.label}</span>
              {theme === option.id && <span className="ml-auto text-xs text-primary">Active</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
