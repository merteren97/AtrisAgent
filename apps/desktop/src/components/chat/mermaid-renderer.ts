import { COLOR_PALETTES, normalizeColorPalette, type ColorPalette } from '@/lib/theme-palettes';

export type MermaidThemeMode = 'light' | 'dark';

export interface MermaidRenderResult {
  svg: string;
  renderId: string;
  width: number | null;
  height: number | null;
}

export interface MermaidThemeVariables {
  darkMode: boolean;
  background: string;
  fontFamily: string;
  fontSize: string;
  primaryColor: string;
  primaryTextColor: string;
  primaryBorderColor: string;
  secondaryColor: string;
  secondaryTextColor: string;
  secondaryBorderColor: string;
  tertiaryColor: string;
  tertiaryTextColor: string;
  tertiaryBorderColor: string;
  mainBkg: string;
  nodeBorder: string;
  lineColor: string;
  textColor: string;
  edgeLabelBackground: string;
  clusterBkg: string;
  clusterBorder: string;
  titleColor: string;
  actorBkg: string;
  actorBorder: string;
  actorTextColor: string;
  actorLineColor: string;
  signalColor: string;
  signalTextColor: string;
  labelBoxBkgColor: string;
  labelBoxBorderColor: string;
  labelTextColor: string;
  noteBkgColor: string;
  noteTextColor: string;
  noteBorderColor: string;
}

const MAX_CACHE_ENTRIES = 64;
const svgCache = new Map<string, MermaidRenderResult>();

type MermaidModule = typeof import('mermaid').default;
let mermaidLoader: Promise<MermaidModule> | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let idCounter = 0;

function parseHexColor(hex: string): [number, number, number] {
  const cleaned = hex.replace('#', '').trim();
  const full = cleaned.length === 3
    ? cleaned.split('').map(ch => ch + ch).join('')
    : cleaned;
  const parsed = Number.parseInt(full, 16);
  if (Number.isNaN(parsed)) return [128, 128, 128];
  return [(parsed >> 16) & 255, (parsed >> 8) & 255, parsed & 255];
}

function toHexChannel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

export function mixHexColors(hexA: string, hexB: string, weightA: number): string {
  const ratio = Math.max(0, Math.min(1, weightA));
  const [r1, g1, b1] = parseHexColor(hexA);
  const [r2, g2, b2] = parseHexColor(hexB);
  const r = r1 * ratio + r2 * (1 - ratio);
  const g = g1 * ratio + g2 * (1 - ratio);
  const b = b1 * ratio + b2 * (1 - ratio);
  return `#${toHexChannel(r)}${toHexChannel(g)}${toHexChannel(b)}`;
}

export function isMermaidLanguage(language?: string): boolean {
  if (!language) return false;
  const primary = language.trim().split(/\s+/)[0]?.toLowerCase() || '';
  return primary === 'mermaid';
}

export function getMermaidDiagramLabel(code: string): string {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  let inDirective = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('%%')) {
      if (line.startsWith('%%{') && !line.includes('}%%')) inDirective = true;
      continue;
    }
    if (inDirective) {
      if (line.includes('}%%')) inDirective = false;
      continue;
    }
    if (/^(?:flowchart|graph)\b/i.test(line)) return 'Flowchart';
    if (/^sequenceDiagram\b/i.test(line)) return 'Sequence';
    if (/^stateDiagram(?:-v2)?\b/i.test(line)) return 'State';
    if (/^classDiagram\b/i.test(line)) return 'Class';
    if (/^erDiagram\b/i.test(line)) return 'ER Diagram';
    if (/^gantt\b/i.test(line)) return 'Gantt';
    if (/^pie\b/i.test(line)) return 'Pie Chart';
    if (/^mindmap\b/i.test(line)) return 'Mindmap';
    if (/^timeline\b/i.test(line)) return 'Timeline';
    if (/^xychart(?:-beta)?\b/i.test(line)) return 'XY Chart';
    if (/^gitGraph\b/i.test(line)) return 'Git Graph';
    if (/^journey\b/i.test(line)) return 'User Journey';
    if (/^quadrantChart\b/i.test(line)) return 'Quadrant';
    if (/^C4(?:Context|Container|Component|Dynamic|Deployment)\b/i.test(line)) return 'C4 Diagram';
    if (/^architecture(?:-beta)?\b/i.test(line)) return 'Architecture';
    if (/^block(?:-beta)?\b/i.test(line)) return 'Block';
    break;
  }
  return 'Diagram';
}

export function buildMermaidThemeVariables(
  mode: MermaidThemeMode,
  paletteId: ColorPalette,
): MermaidThemeVariables {
  const resolvedId = normalizeColorPalette(paletteId);
  const palette = COLOR_PALETTES.find(item => item.id === resolvedId) || COLOR_PALETTES[0];
  const tokens = palette[mode];
  const isDark = mode === 'dark';

  const primaryColor = isDark
    ? mixHexColors(tokens.accent, tokens.surface, 0.16)
    : mixHexColors(tokens.accent, tokens.surface, 0.10);
  const primaryBorderColor = isDark
    ? mixHexColors(tokens.accent, tokens.text, 0.72)
    : mixHexColors(tokens.accent, tokens.text, 0.78);
  const secondaryColor = isDark
    ? mixHexColors(tokens.surface, tokens.canvas, 0.75)
    : mixHexColors(tokens.canvas, tokens.surface, 0.72);
  const secondaryBorderColor = isDark
    ? mixHexColors(tokens.text, tokens.surface, 0.28)
    : mixHexColors(tokens.text, tokens.surface, 0.24);
  const tertiaryColor = isDark
    ? mixHexColors(tokens.accent, tokens.canvas, 0.12)
    : mixHexColors(tokens.accent, tokens.surface, 0.06);
  const tertiaryBorderColor = isDark
    ? mixHexColors(tokens.accent, tokens.surface, 0.45)
    : mixHexColors(tokens.accent, tokens.surface, 0.48);
  const lineColor = isDark
    ? mixHexColors(tokens.text, tokens.surface, 0.62)
    : mixHexColors(tokens.text, tokens.surface, 0.56);
  const edgeLabelBackground = isDark
    ? mixHexColors(tokens.canvas, tokens.surface, 0.45)
    : tokens.surface;
  const clusterBkg = isDark
    ? mixHexColors(tokens.surface, tokens.canvas, 0.52)
    : mixHexColors(tokens.canvas, tokens.surface, 0.65);
  const clusterBorder = isDark
    ? mixHexColors(tokens.text, tokens.surface, 0.30)
    : mixHexColors(tokens.text, tokens.surface, 0.26);
  const noteBkgColor = isDark
    ? mixHexColors(tokens.accent, tokens.surface, 0.22)
    : mixHexColors(tokens.accent, tokens.surface, 0.14);
  const noteBorderColor = isDark
    ? mixHexColors(tokens.accent, tokens.surface, 0.62)
    : mixHexColors(tokens.accent, tokens.surface, 0.55);

  return {
    darkMode: isDark,
    background: 'transparent',
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, sans-serif',
    fontSize: '13px',
    primaryColor,
    primaryTextColor: tokens.text,
    primaryBorderColor,
    secondaryColor,
    secondaryTextColor: tokens.text,
    secondaryBorderColor,
    tertiaryColor,
    tertiaryTextColor: tokens.text,
    tertiaryBorderColor,
    mainBkg: primaryColor,
    nodeBorder: primaryBorderColor,
    lineColor,
    textColor: tokens.text,
    edgeLabelBackground,
    clusterBkg,
    clusterBorder,
    titleColor: tokens.text,
    actorBkg: primaryColor,
    actorBorder: primaryBorderColor,
    actorTextColor: tokens.text,
    actorLineColor: lineColor,
    signalColor: lineColor,
    signalTextColor: tokens.text,
    labelBoxBkgColor: secondaryColor,
    labelBoxBorderColor: secondaryBorderColor,
    labelTextColor: tokens.text,
    noteBkgColor,
    noteTextColor: tokens.text,
    noteBorderColor,
  };
}

export function parseMermaidSvgDimensions(svg: string): { width: number; height: number } | null {
  const svgTagMatch = svg.match(/<svg\b[^>]*>/i);
  if (!svgTagMatch) return null;
  const tag = svgTagMatch[0];

  const viewBoxMatch = tag.match(/\bviewBox=["']\s*[-+]?[\d.]+\s+[-+]?[\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
  if (viewBoxMatch) {
    const width = Number.parseFloat(viewBoxMatch[1]);
    const height = Number.parseFloat(viewBoxMatch[2]);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  const widthMatch = tag.match(/\bwidth=["']\s*([\d.]+)(?:px)?\s*["']/i);
  const heightMatch = tag.match(/\bheight=["']\s*([\d.]+)(?:px)?\s*["']/i);
  if (widthMatch && heightMatch) {
    const width = Number.parseFloat(widthMatch[1]);
    const height = Number.parseFloat(heightMatch[1]);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  return null;
}

export function scopeMermaidSvgIds(svg: string, renderId: string, scopeSuffix: string): string {
  if (!renderId || !scopeSuffix) return svg;
  const escaped = renderId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return svg.replace(new RegExp(escaped, 'g'), `${renderId}-${scopeSuffix}`);
}

export function normalizeMermaidSvgMarkup(svg: string): string {
  return svg.replace(/<svg\b([^>]*)>/i, (_match, rawAttrs: string) => {
    const withoutSize = rawAttrs
      .replace(/\s+width=(["'])[^"']*\1/gi, '')
      .replace(/\s+height=(["'])[^"']*\1/gi, '')
      .replace(/\s+style=(["'])[^"']*\1/gi, '');
    return `<svg${withoutSize} width="100%" height="100%" style="display:block;max-width:none;">`;
  });
}

function getCacheKey(code: string, mode: MermaidThemeMode, palette: ColorPalette): string {
  return `${mode}:${normalizeColorPalette(palette)}:${code}`;
}

function putInCache(key: string, value: MermaidRenderResult): void {
  if (svgCache.has(key)) svgCache.delete(key);
  svgCache.set(key, value);
  if (svgCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = svgCache.keys().next().value;
    if (oldestKey !== undefined) svgCache.delete(oldestKey);
  }
}

export function getCachedMermaidSvg(
  code: string,
  mode: MermaidThemeMode,
  palette: ColorPalette,
): MermaidRenderResult | undefined {
  const key = getCacheKey(code, mode, palette);
  const cached = svgCache.get(key);
  if (!cached) return undefined;
  // Refresh LRU order
  svgCache.delete(key);
  svgCache.set(key, cached);
  return cached;
}

async function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then(mod => mod.default ?? (mod as unknown as MermaidModule));
  }
  return mermaidLoader;
}

function cleanupOrphanMermaidNode(id: string): void {
  if (typeof document === 'undefined') return;
  document.getElementById(id)?.remove();
  document.getElementById(`d${id}`)?.remove();
}

export async function renderMermaidDiagram(
  code: string,
  options: { mode: MermaidThemeMode; palette: ColorPalette },
): Promise<MermaidRenderResult> {
  const trimmed = code.trim();
  if (!trimmed) {
    throw new Error('Empty Mermaid diagram');
  }

  const normalizedPalette = normalizeColorPalette(options.palette);
  const cacheKey = getCacheKey(trimmed, options.mode, normalizedPalette);
  const cached = getCachedMermaidSvg(trimmed, options.mode, normalizedPalette);
  if (cached) return cached;

  const task = renderQueue.then(async () => {
    const rechecked = getCachedMermaidSvg(trimmed, options.mode, normalizedPalette);
    if (rechecked) return rechecked;

    const mermaid = await loadMermaid();
    const themeVariables = buildMermaidThemeVariables(options.mode, normalizedPalette);
    const renderId = `atris-mermaid-${++idCounter}`;

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'base',
      themeVariables,
      flowchart: {
        htmlLabels: true,
        useMaxWidth: false,
        curve: 'basis',
        padding: 16,
        nodeSpacing: 44,
        rankSpacing: 52,
      },
      sequence: {
        useMaxWidth: false,
      },
      state: {
        useMaxWidth: false,
      },
      class: {
        useMaxWidth: false,
      },
      er: {
        useMaxWidth: false,
      },
      gantt: {
        useMaxWidth: false,
      },
    });

    let host: HTMLDivElement | undefined;
    if (typeof document !== 'undefined') {
      host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.position = 'fixed';
      host.style.left = '-99999px';
      host.style.top = '-99999px';
      host.style.width = '0';
      host.style.height = '0';
      host.style.overflow = 'hidden';
      host.style.pointerEvents = 'none';
      document.body.appendChild(host);
    }

    try {
      const rendered = await mermaid.render(renderId, trimmed, host);
      const dims = parseMermaidSvgDimensions(rendered.svg);
      const result: MermaidRenderResult = {
        svg: normalizeMermaidSvgMarkup(rendered.svg),
        renderId,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
      };
      putInCache(cacheKey, result);
      return result;
    } catch (error) {
      cleanupOrphanMermaidNode(renderId);
      throw error;
    } finally {
      host?.remove();
    }
  });

  renderQueue = task.catch(() => {});
  return task;
}
