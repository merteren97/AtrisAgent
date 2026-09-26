import { Check, Laptop, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import { COLOR_PALETTES } from '@/lib/theme-palettes';
import { useSettingsStore } from '@/stores/settings-store';

const modes = [
  { id: 'system', label: 'System', icon: Laptop },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
] as const;

export function ThemePaletteSelector() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const palette = useSettingsStore((state) => state.colorPalette);
  const setPalette = useSettingsStore((state) => state.setColorPalette);
  const previewMode = resolvedTheme === 'light' ? 'light' : 'dark';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Appearance</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Follow your system or choose a fixed light or dark appearance.</p>
        </div>
        <div role="group" aria-label="Appearance mode" className="flex rounded-lg border border-border bg-muted/40 p-1">
          {modes.map(({ id, label, icon: Icon }) => (
            <Button key={id} type="button" size="sm" variant="ghost" aria-pressed={theme === id} onClick={() => setTheme(id)}
              className={`h-8 gap-1.5 px-2.5 text-xs ${theme === id ? 'bg-background text-foreground shadow-sm hover:bg-background' : 'text-muted-foreground'}`}>
              <Icon className="h-3.5 w-3.5" />{label}
            </Button>
          ))}
        </div>
      </div>
      <fieldset className="border-t border-border pt-5">
        <legend className="sr-only">Color palette</legend>
        <div className="mb-3">
          <p className="text-sm font-medium">Color palette</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Each palette adapts its surfaces, text and controls to both appearances. Changes save automatically.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {COLOR_PALETTES.map((option) => {
            const preview = option[previewMode];
            const selected = palette === option.id;
            return (
              <label key={option.id} className={`group cursor-pointer rounded-xl border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${selected ? 'border-primary/60 bg-primary/[0.035]' : 'border-border hover:border-primary/35'}`}>
                <input type="radio" name="color-palette" value={option.id} checked={selected} onChange={() => setPalette(option.id)} className="sr-only" />
                <span className="flex h-16 overflow-hidden rounded-lg border border-border/60" style={{ backgroundColor: preview.canvas, color: preview.text }} aria-hidden="true">
                  <span className="flex w-5 shrink-0 flex-col gap-1 border-r border-current/10 p-1.5"><span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: preview.accent }} /><span className="h-1.5 w-1.5 rounded-full bg-current opacity-30" /></span>
                  <span className="flex min-w-0 flex-1 flex-col justify-center gap-1.5 px-2.5"><span className="h-2 w-2/3 rounded-full bg-current opacity-65" /><span className="h-1.5 w-1/2 rounded-full bg-current opacity-30" /></span>
                  <span className="m-2.5 self-end rounded px-2 py-1 text-[9px] font-semibold" style={{ backgroundColor: preview.accent, color: previewMode === 'dark' && option.id !== 'iris' ? preview.canvas : '#ffffff' }}>Aa</span>
                </span>
                <span className="mt-2.5 flex items-center justify-between gap-2"><span className="text-sm font-medium">{option.label}</span>{selected && <Check className="h-4 w-4 text-primary" aria-label="Selected" />}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
