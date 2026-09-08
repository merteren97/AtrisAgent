import { useState } from 'react';
import { Shield, ChevronDown, Check, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings-store';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

const MODES = [
  { id: 'Review Driven', label: 'Ask', desc: 'Ask before starting plans and making changes.' },
  { id: 'Balanced', label: 'Review', desc: 'Work in isolation and review changes before applying.' },
  { id: 'Autonomous', label: 'Auto', desc: 'Run plans and allowed actions automatically. Git push still asks.' },
  { id: 'Candidate', label: 'Review + Candidate', desc: 'Compare parallel solutions, then choose one to review.' },
] as const;

const ACTIONS = [
  { id: 'fileWrite', label: 'File changes', description: 'Create and edit files in the agent workspace.' },
  { id: 'gitCommit', label: 'Git commits', description: 'Record local changes in Git.' },
  { id: 'packageInstall', label: 'Package installation', description: 'Install dependencies needed for the task.' },
] as const;

export function TrustModeSelector() {
  const { trustMode, setTrustMode, automationSettings, setAutomationSettings } = useSettingsStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const selectedMode = MODES.find((mode) => mode.id === trustMode) || MODES[1];
  const overrideCount = ACTIONS.filter((action) => automationSettings[action.id] !== null).length;

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-[11px] text-muted-foreground hover:text-foreground" aria-label={`Automation: ${selectedMode.label}${overrideCount ? `, ${overrideCount} custom rules` : ''}`} title={selectedMode.desc}>
            <Shield className="h-3.5 w-3.5" />
            {selectedMode.label}
            {overrideCount > 0 && <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64" onCloseAutoFocus={(event) => { if (settingsOpen) event.preventDefault(); }}>
          {MODES.map((mode) => (
            <DropdownMenuItem key={mode.id} onClick={() => setTrustMode(mode.id)} className="flex flex-col items-start gap-1 p-2.5">
              <div className="flex w-full items-center justify-between text-xs font-medium">
                {mode.label}
                {trustMode === mode.id && <Check className="h-3.5 w-3.5 text-primary" />}
              </div>
              <span className="text-[11px] leading-relaxed text-muted-foreground">{mode.desc}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="gap-2 text-xs" onSelect={() => setSettingsOpen(true)}>
            <Settings2 className="h-3.5 w-3.5" />
            Customize automation
            {overrideCount > 0 && <span className="ml-auto text-muted-foreground">{overrideCount}</span>}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DialogContent className="min-w-0 sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Automation settings</DialogTitle>
          <DialogDescription>Choose exceptions to {selectedMode.label} mode for your next request. Use the mode default to inherit its behavior.</DialogDescription>
        </DialogHeader>
        <div className="divide-y divide-border">
          {ACTIONS.map((action) => (
            <div key={action.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div className="min-w-0 flex-1 basis-44">
                <Label htmlFor={action.id}>{action.label}</Label>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{action.description}</p>
              </div>
              <select id={action.id} className="h-9 max-w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={automationSettings[action.id] === null ? 'default' : automationSettings[action.id] ? 'auto' : 'ask'}
                onChange={(event) => setAutomationSettings({ [action.id]: event.target.value === 'default' ? null : event.target.value === 'auto' })}>
                <option value="default">Mode default</option>
                <option value="auto">Allow automatically</option>
                <option value="ask">Ask first</option>
              </select>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <Button variant="ghost" size="sm" disabled={!overrideCount} onClick={() => setAutomationSettings({ fileWrite: null, gitCommit: null, packageInstall: null })}>Reset to mode defaults</Button>
          <Button size="sm" onClick={() => setSettingsOpen(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
