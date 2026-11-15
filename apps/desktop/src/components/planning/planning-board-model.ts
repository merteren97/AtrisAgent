import type { PlanningBoard, PlanningBoardItem, PlanningBoardKind, PlanningBoardSection, PlanningBoardStatus } from '@/stores/planning-store';

export const boardKinds: Array<{ id: PlanningBoardKind; label: string }> = [
  { id: 'section', label: 'Section' }, { id: 'gallery', label: 'Gallery' }, { id: 'comparison', label: 'Comparison' },
  { id: 'checklist', label: 'Checklist' }, { id: 'research', label: 'Research' }, { id: 'note', label: 'Note' },
];
export const boardStatuses: Array<{ id: PlanningBoardStatus; label: string; variant: 'default' | 'outline' | 'success' | 'warning' | 'destructive' }> = [
  { id: 'idea', label: 'Idea', variant: 'outline' }, { id: 'in-progress', label: 'In progress', variant: 'default' },
  { id: 'review', label: 'Review', variant: 'warning' }, { id: 'done', label: 'Done', variant: 'success' }, { id: 'blocked', label: 'Blocked', variant: 'destructive' },
];
export const kindLabel = (kind: PlanningBoardKind) => boardKinds.find(entry => entry.id === kind)?.label || 'Section';
export interface BoardEntry { path: string[]; trail: string[]; section: PlanningBoardSection; item?: PlanningBoardItem }
export function flattenBoard(sections: PlanningBoardSection[], path: string[] = [], trail: string[] = []): BoardEntry[] {
  return sections.flatMap(section => {
    const next = [...path, section.id], titles = [...trail, section.title];
    return [{ path: next, trail: titles, section }, ...(section.items || []).map(item => ({ path: next, trail: titles, section, item })), ...flattenBoard(section.children || [], next, titles)];
  });
}
export function sectionAt(sections: PlanningBoardSection[], path: string[]): PlanningBoardSection | undefined {
  let entries = sections, found: PlanningBoardSection | undefined;
  for (const id of path) { found = entries.find(entry => entry.id === id); if (!found) return; entries = found.children || []; }
  return found;
}
export function validBoardPath(sections: PlanningBoardSection[], path: string[]): string[] {
  let entries = sections; const result: string[] = [];
  for (const id of path) { const found = entries.find(entry => entry.id === id); if (!found) break; result.push(id); entries = found.children || []; }
  return result;
}
export function searchBoard(entries: BoardEntry[], query: string, status: PlanningBoardStatus | '') {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => {
    const node = entry.item || entry.section;
    const haystack = [node.title, node.body, entry.item?.prompt, entry.item?.source, !entry.item && entry.section.summary].filter(Boolean).join(' ').toLocaleLowerCase();
    return (!status || node.status === status) && terms.every(term => haystack.includes(term));
  });
}
export function boardProgress(entries: BoardEntry[]) {
  const items = entries.flatMap(entry => entry.item ? [entry.item] : []);
  return { total: items.length, tracked: items.filter(item => item.status).length, done: items.filter(item => item.status === 'done').length, blocked: items.filter(item => item.status === 'blocked').length };
}
export function boardChanges(saved: PlanningBoard | null, draft: PlanningBoard): string[] {
  const index = (board: PlanningBoard | null) => new Map(flattenBoard(board?.sections || []).map(entry => [entry.item?.id || entry.section.id, entry]));
  const before = index(saved), after = index(draft); const changes: string[] = [];
  if (saved?.summary !== draft.summary) changes.push('Updated project overview');
  if (saved?.cover !== draft.cover) changes.push('Updated project cover');
  if (JSON.stringify(saved?.appearance) !== JSON.stringify(draft.appearance)) changes.push('Updated typography, accent or spacing');
  for (const [id, entry] of after) {
    const node = entry.item || entry.section, old = before.get(id), previous = old && (old.item || old.section);
    if (!previous) { changes.push(`Added ${entry.item ? 'item' : 'section'}: ${node.title}`); continue; }
    if (previous.title !== node.title) changes.push(`Renamed “${previous.title}” to “${node.title}”`);
    if (previous.status !== node.status) changes.push(`${node.title}: ${previous.status || 'no status'} → ${node.status || 'no status'}`);
    const omitMeta = ({ title: _title, status: _status, children: _children, items: _items, ...rest }: PlanningBoardSection & Partial<PlanningBoardItem>) => rest;
    if (JSON.stringify(omitMeta(previous as PlanningBoardSection)) !== JSON.stringify(omitMeta(node as PlanningBoardSection))) changes.push(`Updated content: ${node.title}`);
    if (old && old.path.join('/') !== entry.path.join('/')) changes.push(`Moved: ${node.title}`);
  }
  for (const [id, entry] of before) if (!after.has(id)) changes.push(`Removed ${entry.item ? 'item' : 'section'}: ${(entry.item || entry.section).title}`);
  const order = (board: PlanningBoard | null) => flattenBoard(board?.sections || []).map(entry => entry.item?.id || entry.section.id).filter(id => before.has(id) && after.has(id)).join('|');
  if (order(saved) !== order(draft)) changes.push('Changed section or item order');
  return changes;
}
