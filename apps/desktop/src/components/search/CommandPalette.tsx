import { useEffect, useState, useRef } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useSettingsStore } from '@/stores/settings-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useMissionStore } from '@/stores/mission-store';
import { Search, FolderGit2, Activity, Settings, Bot, Folder, File } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';

export function CommandPalette() {
  const { commandPaletteOpen, setCommandPaletteOpen, setActiveView } = useSettingsStore();
  const { workspaces, setActiveWorkspace } = useWorkspaceStore();
  const { missions, setActiveMission, setMissionFilter } = useMissionStore();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commandPaletteOpen, setCommandPaletteOpen]);

  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [commandPaletteOpen]);

  const items = [
    // Views
    ...[
      { id: 'view-chat', title: 'Go to Chat', icon: Activity, type: 'View', onSelect: () => { setActiveView('chat'); setMissionFilter('active'); } },
      { id: 'view-dashboard', title: 'Go to Dashboard', icon: Activity, type: 'View', onSelect: () => setActiveView('dashboard') },
      { id: 'view-projects', title: 'Go to Projects', icon: FolderGit2, type: 'View', onSelect: () => setActiveView('projects') },
      { id: 'view-agents', title: 'Go to Agents', icon: Bot, type: 'View', onSelect: () => setActiveView('agents') },
      { id: 'view-accounts', title: 'Go to Accounts & Models', icon: Settings, type: 'View', onSelect: () => setActiveView('accounts') },
      { id: 'view-settings', title: 'Go to Settings', icon: Settings, type: 'View', onSelect: () => setActiveView('settings') },
    ],
    // Workspaces
    ...workspaces.map(ws => ({
      id: `ws-${ws.id}`,
      title: `Switch to ${ws.name}`,
      icon: Folder,
      type: 'Workspace',
      onSelect: () => setActiveWorkspace(ws.id)
    })),
    // Missions
    ...missions.map(m => ({
      id: `mission-${m.id}`,
      title: `Mission: ${m.title}`,
      icon: File,
      type: 'Mission',
      onSelect: () => setActiveMission(m.id)
    }))
  ].filter(item => item.title.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(items.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + items.length) % Math.max(items.length, 1));
    } else if (e.key === 'Enter' && items[selectedIndex]) {
      e.preventDefault();
      items[selectedIndex].onSelect();
      setCommandPaletteOpen(false);
    }
  };

  return (
    <Dialog open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen}>
      <DialogContent showCloseButton={false} className="p-0 overflow-hidden max-w-2xl bg-background border-border shadow-2xl">
        <div className="flex items-center px-4 py-3 border-b border-border">
          <Search className="w-5 h-5 text-muted-foreground mr-3" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent border-none outline-none text-base placeholder:text-muted-foreground text-foreground"
            placeholder="Type a command or search..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <kbd className="bg-muted px-1.5 py-0.5 rounded border border-border font-sans">↑</kbd>
            <kbd className="bg-muted px-1.5 py-0.5 rounded border border-border font-sans">↓</kbd>
            <span className="ml-1">to navigate</span>
            <kbd className="bg-muted px-1.5 py-0.5 rounded border border-border font-sans ml-2">↵</kbd>
            <span className="ml-1">to select</span>
          </div>
        </div>
        <ScrollArea className="max-h-[350px]">
          {items.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No results found.</div>
          ) : (
            <div className="p-2 space-y-1">
              {items.map((item, index) => {
                const Icon = item.icon;
                const isSelected = index === selectedIndex;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      item.onSelect();
                      setCommandPaletteOpen(false);
                    }}
                    onMouseEnter={() => setSelectedIndex(index)}
                    className={`flex items-center w-full px-3 py-2.5 text-sm rounded-md transition-colors cursor-pointer ${
                      isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-muted'
                    }`}
                  >
                    <Icon className={`w-4 h-4 mr-3 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                    <span className="flex-1 text-left truncate">{item.title}</span>
                    <span className="text-[10px] text-muted-foreground px-2 py-0.5 rounded-full bg-muted/50 border border-border/50">
                      {item.type}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
