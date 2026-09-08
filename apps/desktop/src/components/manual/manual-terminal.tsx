import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTheme } from 'next-themes';
import '@xterm/xterm/css/xterm.css';

export interface TerminalSnapshot { id: string; status: 'open' | 'closed' | 'exited' | 'disconnected'; sequence: number; output: string; reset: boolean }

// The emulator, including device/cursor replies, lives beyond any React view.
// A background CLI must not wait for a user to reopen its Code pane.
const engines = new Map<string, ReturnType<typeof createEngine>>();
function createEngine(id: string) {
  const container = document.createElement('div');
  container.className = 'h-full w-full';
  const terminal = new Terminal({ cols: 120, rows: 30, cursorBlink: true, fontSize: 13,
    fontFamily: 'Cascadia Code, Consolas, monospace', scrollback: 5000, allowProposedApi: false });
  const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container);
  let disposed = false; let after = 0; let status = 'disconnected'; let size = '';
  let error: string | null = null; let timer: ReturnType<typeof setTimeout>;
  let writes = Promise.resolve();
  const listeners = new Set<(error: string | null) => void>();
  const update = (value: string | null) => { error = value; listeners.forEach(listener => listener(error)); };
  const resize = () => {
    if (disposed || !container.isConnected || !container.clientWidth || !container.clientHeight) return;
    fit.fit();
    const next = terminal.cols+':'+terminal.rows;
    if (next === size || status !== 'open') return;
    size = next;
    void invoke('manual_terminal_resize', { id, columns: terminal.cols, rows: terminal.rows }).catch(e => { if (!disposed) update(String(e)); });
  };
  const input = terminal.onData(data => {
    if (status !== 'open') return;
    writes = writes.then(() => disposed ? undefined : invoke<void>('manual_terminal_write', { id, data, paste: false })).catch(e => { if (!disposed) update(String(e)); });
  });
  const poll = async () => {
    try {
      const snapshot = await invoke<TerminalSnapshot>('manual_terminal_snapshot', { id, after });
      if (disposed) return;
      status = snapshot.status;
      if (snapshot.reset) terminal.reset();
      after = snapshot.sequence;
      if (snapshot.output) await new Promise<void>(resolve => terminal.write(snapshot.output, resolve));
      if (disposed) return;
      update(status === 'open' ? null : 'Agent '+status+'. Use Open agent to reconnect.');
      resize();
    } catch (e) { if (!disposed) update(String(e)); }
    finally { if (!disposed) timer = setTimeout(poll, status === 'open' ? 120 : 1500); }
  };
  void poll();
  return { terminal, container, resize,
    subscribe(listener: (error: string | null) => void) { listeners.add(listener); listener(error); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; clearTimeout(timer); input.dispose(); terminal.dispose(); listeners.clear(); },
  };
}

export function ensureManualTerminal(id: string, restart = false) {
  if (restart) { engines.get(id)?.dispose(); engines.delete(id); }
  let engine = engines.get(id);
  if (!engine) { engine = createEngine(id); engines.set(id, engine); }
  return engine;
}

export function ManualTerminal({ id, generation = 0 }: { id: string; generation?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const { resolvedTheme, forcedTheme } = useTheme();
  const effectiveTheme = forcedTheme || resolvedTheme;
  useEffect(() => {
    const root = host.current; if (!root) return;
    const engine = ensureManualTerminal(id);
    root.appendChild(engine.container);
    const unsubscribe = engine.subscribe(setError);
    const observer = new ResizeObserver(engine.resize); observer.observe(root); engine.resize();
    return () => {
      unsubscribe(); observer.disconnect(); engine.container.remove();
      // Keep parsing native output in Chat, other conversations, and settings.
    };
  }, [id, generation]);
  useEffect(() => {
    ensureManualTerminal(id).terminal.options.theme = {
      background: effectiveTheme === 'light' ? '#ffffff' : '#101114',
      foreground: effectiveTheme === 'light' ? '#202124' : '#e4e4e7',
    };
  }, [id, generation, effectiveTheme]);
  return <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background">
    {error && <p role="status" className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">{error}</p>}
    <div ref={host} className="min-h-0 flex-1 p-2" aria-label="Interactive agent terminal" />
  </div>;
}
