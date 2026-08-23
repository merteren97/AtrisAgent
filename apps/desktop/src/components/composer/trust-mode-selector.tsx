import { Shield, ChevronDown, Check, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings-store';
import { useLanguageStore, t } from '@/stores/language-store';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

const MODES = [
  { id: 'Review Driven', label: 'Ask', desc: 'Request approval before governed actions' },
  { id: 'Balanced', label: 'Review', desc: 'Work in isolation, then require quality review' },
  { id: 'Autonomous', label: 'Auto', desc: 'Automate allowed actions; pushes still require approval' },
  { id: 'Candidate', label: 'Review + Candidate', desc: 'Review policy with parallel Builder candidates' },
] as const;

export function TrustModeSelector() {
  const { trustMode, setTrustMode, automationSettings, setAutomationSettings } = useSettingsStore();
  useLanguageStore(); // trigger re-renders

  return (
    <Dialog>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 text-[10px] gap-1 text-muted-foreground hover:text-foreground" title={t('Trust Mode')}>
            <Shield className="w-3 h-3" />
            {MODES.find((mode) => mode.id === trustMode)?.label || trustMode}
            <ChevronDown className="w-2.5 h-2.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48 text-xs">
          {MODES.map((m) => (
            <DropdownMenuItem 
              key={m.id} 
              onClick={() => setTrustMode(m.id)}
              className="flex flex-col items-start gap-1 p-2"
            >
              <div className="flex items-center w-full justify-between font-medium">
                {m.label}
                {trustMode === m.id && <Check className="w-3 h-3 text-primary" />}
              </div>
              <span className="text-[10px] text-muted-foreground">{m.desc}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DialogTrigger asChild>
            <DropdownMenuItem className="gap-2 cursor-pointer">
              <Settings2 className="w-3.5 h-3.5" />
              Fine-tune Automation
            </DropdownMenuItem>
          </DialogTrigger>
        </DropdownMenuContent>
      </DropdownMenu>

      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Automation Settings</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <Label htmlFor="file-write">File Write</Label>
              <span className="text-xs text-muted-foreground">Allow agents to write files without confirmation.</span>
            </div>
            <Switch
              id="file-write"
               checked={automationSettings.fileWrite === true}
              onCheckedChange={(c) => setAutomationSettings({ fileWrite: c })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <Label htmlFor="git-commit">Git Commit</Label>
              <span className="text-xs text-muted-foreground">Allow agents to commit to git automatically.</span>
            </div>
            <Switch
              id="git-commit"
               checked={automationSettings.gitCommit === true}
              onCheckedChange={(c) => setAutomationSettings({ gitCommit: c })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <Label htmlFor="pkg-install">Package Install</Label>
              <span className="text-xs text-muted-foreground">Allow agents to install npm packages.</span>
            </div>
            <Switch
              id="pkg-install"
               checked={automationSettings.packageInstall === true}
              onCheckedChange={(c) => setAutomationSettings({ packageInstall: c })}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
