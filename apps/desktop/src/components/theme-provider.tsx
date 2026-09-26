import { useLayoutEffect } from 'react';
import { ThemeProvider as NextThemesProvider, type ThemeProviderProps } from 'next-themes';
import { useSettingsStore } from '@/stores/settings-store';

function PaletteSync() {
  const palette = useSettingsStore((state) => state.colorPalette);

  useLayoutEffect(() => {
    document.documentElement.dataset.palette = palette;
  }, [palette]);

  return null;
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}><PaletteSync />{children}</NextThemesProvider>;
}
