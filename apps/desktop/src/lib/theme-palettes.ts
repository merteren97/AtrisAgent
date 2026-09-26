export const COLOR_PALETTES = [
  {
    id: 'iris', label: 'Iris', description: 'The AtrisAgent original',
    light: { canvas: '#fafafa', surface: '#ffffff', text: '#101827', accent: '#6745ef' },
    dark: { canvas: '#101116', surface: '#191a21', text: '#e7eaf0', accent: '#8062f4' },
  },
  {
    id: 'graphite', label: 'Graphite', description: 'Quiet monochrome',
    light: { canvas: '#f7f8f9', surface: '#ffffff', text: '#202731', accent: '#4a5b6e' },
    dark: { canvas: '#15181c', surface: '#1d2227', text: '#e3e8ed', accent: '#b5c4d0' },
  },
  {
    id: 'ocean', label: 'Ocean', description: 'Cool blue workspace',
    light: { canvas: '#f4f9fb', surface: '#ffffff', text: '#172e3d', accent: '#08759c' },
    dark: { canvas: '#0e1b25', surface: '#142632', text: '#dfedf3', accent: '#57c2d9' },
  },
  {
    id: 'forest', label: 'Forest', description: 'Soft green workspace',
    light: { canvas: '#f5faf7', surface: '#ffffff', text: '#20342b', accent: '#288260' },
    dark: { canvas: '#101d19', surface: '#192923', text: '#e1efe7', accent: '#72caa3' },
  },
  {
    id: 'copper', label: 'Copper', description: 'Warm, focused contrast',
    light: { canvas: '#faf7f3', surface: '#ffffff', text: '#392b24', accent: '#bd612e' },
    dark: { canvas: '#211915', surface: '#2c211b', text: '#f1e8de', accent: '#eba56d' },
  },
] as const;

export type ColorPalette = (typeof COLOR_PALETTES)[number]['id'];

export function normalizeColorPalette(value: unknown): ColorPalette {
  return COLOR_PALETTES.find((palette) => palette.id === value)?.id || 'iris';
}
