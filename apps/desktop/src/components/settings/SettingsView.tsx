import type { ReactNode } from 'react';
import { useSettingsStore, type CloseBehavior } from '@/stores/settings-store';
import { useLanguageStore } from '@/stores/language-store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/theme-toggle';
import { ExecutionPolicyEditor } from './ExecutionPolicyEditor';
import { Braces, KeyRound, Minimize2, MonitorCog, Power, ShieldCheck, Terminal } from 'lucide-react';

const closeBehaviorOptions: Array<{
  value: CloseBehavior;
  title: string;
  description: string;
  icon: typeof Power;
}> = [
  {
    value: 'quit',
    title: 'Quit AtrisAgent',
    description: 'Close the desktop app and stop its local runtime completely.',
    icon: Power,
  },
  {
    value: 'tray',
    title: 'Minimize to tray',
    description: 'Hide the window while keeping AtrisAgent and active local work running. Use the tray menu to reopen or quit.',
    icon: Minimize2,
  },
];

export function SettingsView() {
  const {
    telemetryOptIn,
    setTelemetryOptIn,
    devMode,
    toggleDevMode,
    setActiveView,
    trustMode,
    setTrustMode,
    closeBehavior,
    setCloseBehavior,
  } = useSettingsStore();
  const { language, setLanguage } = useLanguageStore();

  return (
    <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-background p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-6 pb-10">
        <header className="border-b border-border pb-5">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-primary"><MonitorCog className="h-4 w-4" /> Application settings</div>
          <h1 className="text-2xl font-semibold tracking-tight">AtrisAgent preferences</h1>
          <p className="mt-1 text-sm text-muted-foreground">Control local privacy, application behavior, approval posture and role-specific runtime routing. Runtime accounts remain managed through verified CLI flows.</p>
        </header>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4 text-emerald-400" /> Privacy & local operation</CardTitle><CardDescription>AtrisAgent is local-first. Telemetry remains off unless you explicitly enable it.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <SettingRow title="Anonymous diagnostics" description="Allow non-secret crash and performance diagnostics. Prompts, source files and credentials are excluded."><Switch checked={telemetryOptIn} onCheckedChange={setTelemetryOptIn} /></SettingRow>
            <SettingRow title="Theme" description="Use the system, light or dark appearance."><ThemeToggle /></SettingRow>
            <SettingRow title="Interface language" description="Language affects the desktop UI, not agent prompts or repository files."><select value={language} onChange={(event) => setLanguage(event.target.value as 'en' | 'tr')} className="h-9 min-w-28 rounded-md border border-input bg-background px-3 text-sm"><option value="en">English</option><option value="tr">Türkçe</option></select></SettingRow>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Power className="h-4 w-4 text-primary" /> Window & background behavior</CardTitle>
            <CardDescription>Choose what AtrisAgent should do when you close its main window.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {closeBehaviorOptions.map((option) => {
              const Icon = option.icon;
              const active = closeBehavior === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setCloseBehavior(option.value)}
                  className={`rounded-xl border p-4 text-left transition-colors ${active ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/30'}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${active ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-muted/30 text-muted-foreground'}`}>
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <span className="text-sm font-semibold">{option.title}</span>
                    </div>
                    {active && <Badge>Active</Badge>}
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{option.description}</p>
                </button>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Braces className="h-4 w-4 text-primary" /> Approval policy</CardTitle><CardDescription>The selected trust mode controls approvals at the Atris policy layer. Runtime sandboxes remain enabled independently.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            {(['Review Driven', 'Balanced', 'Autonomous'] as const).map((mode) => (
              <button key={mode} onClick={() => setTrustMode(mode)} className={`rounded-xl border p-4 text-left transition-colors ${trustMode === mode ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/30'}`}>
                <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{mode}</span>{trustMode === mode && <Badge>Active</Badge>}</div>
                <p className="mt-2 text-xs text-muted-foreground">{mode === 'Review Driven' ? 'Approve plans, risky commands and applying changes.' : mode === 'Balanced' ? 'Safe workspace work proceeds; risky operations require approval.' : 'Run inside configured workspace boundaries with minimal interruption.'}</p>
              </button>
            ))}
          </CardContent>
        </Card>

        <ExecutionPolicyEditor />

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Terminal className="h-4 w-4 text-amber-400" /> Developer surfaces</CardTitle><CardDescription>Raw console output is intentionally hidden from the normal mission experience.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <SettingRow title="Developer Mode" description="Reveal raw runtime events, session identifiers and console controls."><Switch checked={devMode} onCheckedChange={toggleDevMode} /></SettingRow>
            <SettingRow title="CLI accounts and model catalogs" description="Scan installed runtimes, run official login flows and refresh live account-scoped models."><Button variant="outline" onClick={() => setActiveView('accounts')}><KeyRound className="mr-2 h-4 w-4" />Manage accounts</Button></SettingRow>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-stretch gap-4 rounded-xl border border-border/70 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0"><div className="text-sm font-medium">{title}</div><div className="mt-1 text-xs text-muted-foreground">{description}</div></div>
      <div className="flex shrink-0 justify-end">{children}</div>
    </div>
  );
}