// AtrisWork-style split geometry, scoped to manual conversations. Layout never owns processes.
export type TerminalLayout = { type: 'terminal'; terminalId: string } | { type: 'split'; id: string; direction: 'horizontal' | 'vertical'; ratio: number; children: [TerminalLayout, TerminalLayout] };
export type Placement = 'left' | 'right' | 'top' | 'bottom' | 'swap';
const split = (a: TerminalLayout, b: TerminalLayout, direction: 'horizontal' | 'vertical', ratio = .5): TerminalLayout => ({ type: 'split', id: crypto.randomUUID(), direction, ratio, children: [a, b] });
const leaf = (terminalId: string): TerminalLayout => ({ type: 'terminal', terminalId });
export function layoutIds(node?: TerminalLayout): string[] { return !node ? [] : node.type === 'terminal' ? [node.terminalId] : node.children.flatMap(layoutIds); }
export function automaticLayout(ids: string[], columns: number): TerminalLayout | undefined {
  if (!ids.length) return;
  const balanced = (nodes: TerminalLayout[], direction: 'horizontal' | 'vertical'): TerminalLayout => {
    if (nodes.length === 1) return nodes[0];
    const mid = Math.ceil(nodes.length / 2);
    return split(balanced(nodes.slice(0, mid), direction), balanced(nodes.slice(mid), direction), direction, mid / nodes.length);
  };
  const rows: TerminalLayout[] = [];
  for (let i = 0; i < ids.length; i += columns) rows.push(balanced(ids.slice(i, i + columns).map(leaf), 'horizontal'));
  return balanced(rows, 'vertical');
}
export function reconcileLayout(node: TerminalLayout | undefined, ids: string[]): TerminalLayout | undefined {
  const seen = new Set<string>();
  const prune = (current?: TerminalLayout): TerminalLayout | undefined => {
    if (!current) return;
    if (current.type === 'terminal') { if (!ids.includes(current.terminalId) || seen.has(current.terminalId)) return; seen.add(current.terminalId); return current; }
    const a = prune(current.children[0]); const b = prune(current.children[1]);
    return a && b ? { ...current, children: [a, b] } : a || b;
  };
  let result = prune(node);
  for (const id of ids) if (!seen.has(id)) result = result ? split(result, leaf(id), 'vertical', .7) : leaf(id);
  return result;
}
export function moveInLayout(node: TerminalLayout, source: string, target: string, placement: Placement): TerminalLayout {
  const ids = layoutIds(node);
  if (source === target || !ids.includes(source) || !ids.includes(target)) return node;
  if (placement === 'swap') {
    const swap = (current: TerminalLayout): TerminalLayout => current.type === 'terminal' ? leaf(current.terminalId === source ? target : current.terminalId === target ? source : current.terminalId) : { ...current, children: [swap(current.children[0]), swap(current.children[1])] };
    return swap(node);
  }
  const base = reconcileLayout(node, ids.filter(id => id !== source))!;
  const insert = (current: TerminalLayout): TerminalLayout => {
    if (current.type === 'terminal') return current.terminalId !== target ? current : ['left', 'top'].includes(placement) ? split(leaf(source), current, placement === 'left' ? 'horizontal' : 'vertical') : split(current, leaf(source), placement === 'right' ? 'horizontal' : 'vertical');
    return { ...current, children: [insert(current.children[0]), insert(current.children[1])] };
  };
  return insert(base);
}
export function resizeLayout(node: TerminalLayout, id: string, ratio: number): TerminalLayout {
  if (node.type === 'terminal') return node;
  return { ...node, ratio: node.id === id ? Math.max(.2, Math.min(.8, Number.isFinite(ratio) ? ratio : .5)) : node.ratio, children: [resizeLayout(node.children[0], id, ratio), resizeLayout(node.children[1], id, ratio)] };
}
export function minimumLayout(node?: TerminalLayout): { width: number; height: number } {
  if (!node) return { width: 0, height: 0 };
  if (node.type === 'terminal') return { width: 320, height: 240 };
  const a = minimumLayout(node.children[0]), b = minimumLayout(node.children[1]);
  return node.direction === 'horizontal' ? { width: a.width + b.width + 8, height: Math.max(a.height, b.height) } : { width: Math.max(a.width, b.width), height: a.height + b.height + 8 };
}
export interface PaneRect { left: number; top: number; width: number; height: number }
export interface DividerRect extends PaneRect { id: string; direction: 'horizontal' | 'vertical'; ratio: number; origin: number; available: number }
export function layoutRects(node: TerminalLayout | undefined, width: number, height: number) {
  const panes: Record<string, PaneRect> = {}; const dividers: DividerRect[] = [];
  function visit(current: TerminalLayout, rect: PaneRect) {
    if (current.type === 'terminal') { panes[current.terminalId] = rect; return; }
    const horizontal = current.direction === 'horizontal';
    const a = minimumLayout(current.children[0]), b = minimumLayout(current.children[1]);
    const available = (horizontal ? rect.width : rect.height) - 8;
    const first = Math.max(horizontal ? a.width : a.height, Math.min(available - (horizontal ? b.width : b.height), available * current.ratio));
    dividers.push({ id: current.id, direction: current.direction, ratio: current.ratio, origin: horizontal ? rect.left : rect.top, available, left: rect.left + (horizontal ? first : 0), top: rect.top + (horizontal ? 0 : first), width: horizontal ? 8 : rect.width, height: horizontal ? rect.height : 8 });
    visit(current.children[0], { ...rect, ...(horizontal ? { width: first } : { height: first }) });
    visit(current.children[1], { ...rect, ...(horizontal ? { left: rect.left + first + 8, width: available - first } : { top: rect.top + first + 8, height: available - first }) });
  }
  if (node) visit(node, { left: 0, top: 0, width, height });
  return { panes, dividers };
}
export function dropPlacement(x: number, y: number, width: number, height: number): Placement {
  const dx = x / width, dy = y / height;
  if (dx > .25 && dx < .75 && dy > .25 && dy < .75) return 'swap';
  const distances = { left: dx, right: 1 - dx, top: dy, bottom: 1 - dy };
  return (Object.entries(distances).sort((a, b) => a[1] - b[1])[0]?.[0] || 'swap') as Placement;
}
