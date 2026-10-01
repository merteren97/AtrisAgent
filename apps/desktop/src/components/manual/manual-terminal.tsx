import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTheme } from 'next-themes';
import '@xterm/xterm/css/xterm.css';

export interface TerminalSnapshot {
  id: string; status: 'open' | 'closed' | 'exited' | 'disconnected'; sequence: number; output: string; reset: boolean;
  columns?: number; rows?: number;
  resizes?: { offset: number; columns: number; rows: number }[];
}

// The emulator, including device/cursor replies, lives beyond any React view.
// A background CLI must not wait for a user to reopen its Code pane.
const engines = new Map<string, ReturnType<typeof createEngine>>();
function createEngine(id: string) {
  const container = document.createElement('div');
  container.className = 'h-full w-full';
  // xterm must measure fonts in a connected, sized element, including background startup.
  const parking = document.createElement('div');
  parking.setAttribute('aria-hidden', 'true');
  Object.assign(parking.style, { position: 'fixed', left: '-10000px', top: '0', width: '960px', height: '600px', visibility: 'hidden', pointerEvents: 'none' });
  document.body.appendChild(parking); parking.appendChild(container);
  const terminal = new Terminal({ cols: 120, rows: 30, cursorBlink: true, fontSize: 13,
    fontFamily: 'Cascadia Mono, Consolas, monospace', scrollback: 5000, allowProposedApi: false,
    // Use ConPTY's row-growth policy. Width reflow still follows xterm's defaults.
    windowsPty: /Windows/i.test(navigator.userAgent) ? { backend: 'conpty' } : undefined });
  const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container);
  let disposed = false; let after = 0; let status = 'disconnected'; let size = ''; let epoch = 0;
  let error: string | null = null; let timer: ReturnType<typeof setTimeout>;
  let writes = Promise.resolve();
  let frame = 0;
  let operations = Promise.resolve();
  const listeners = new Set<(error: string | null) => void>();
  const update = (value: string | null) => { error = value; listeners.forEach(listener => listener(error)); };
  // Parsing, geometry changes and resets share one queue. In particular, a reset
  // cannot run halfway through an asynchronous xterm write from the previous CLI.
  const enqueue = (run: () => Promise<void> | void) => {
    operations = operations.then(run).catch(e => { if (!disposed) update(String(e)); });
    return operations;
  };
  const resize = () => {
    if (frame || disposed || container.parentElement === parking) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const resizeEpoch = epoch;
      void enqueue(async () => {
        if (disposed || resizeEpoch !== epoch || status === 'disconnected' || container.parentElement === parking || !container.clientWidth || !container.clientHeight) return;
        const proposed = fit.proposeDimensions();
        if (!proposed) return;
        // Keep emulator dimensions identical to the native PTY's safety limits.
        const cols = Math.min(500, Math.max(2, proposed.cols)), rows = Math.min(300, Math.max(2, proposed.rows));
        if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
        const next = cols+':'+rows;
        if (status === 'open' && next !== size) {
          await invoke('manual_terminal_resize', { id, columns: cols, rows });
          if (disposed || resizeEpoch !== epoch) return;
          size = next;
        }
        if (!disposed && container.parentElement !== parking) terminal.refresh(0, Math.max(0, terminal.rows - 1));
      });
    });
  };
  const input = terminal.onData(data => {
    if (status !== 'open') return;
    const inputEpoch = epoch;
    writes = writes.then(() => disposed || inputEpoch !== epoch ? undefined : invoke<void>('manual_terminal_write', { id, data, paste: false })).catch(e => { if (!disposed) update(String(e)); });
  });
  const poll = async () => {
    const pollEpoch = epoch;
    try {
      await enqueue(async () => {
        if (disposed || pollEpoch !== epoch) return;
        const snapshot = await invoke<TerminalSnapshot>('manual_terminal_snapshot', { id, after });
        if (disposed || pollEpoch !== epoch) return;
        status = snapshot.status;
        if (snapshot.reset) terminal.reset();
        // A replay may span several native grids. Apply each resize at its stream
        // boundary rather than interpreting all historical cursor moves at today's size.
        let offset = 0;
        const write = async (text: string) => { if (text) await new Promise<void>(resolve => terminal.write(text, resolve)); };
        for (const geometry of snapshot.resizes || []) {
          await write(snapshot.output.slice(offset, geometry.offset));
          if (disposed || pollEpoch !== epoch) return;
          terminal.resize(geometry.columns, geometry.rows);
          offset = geometry.offset;
        }
        await write(snapshot.output.slice(offset));
        if (disposed || pollEpoch !== epoch) return;
        if (snapshot.columns && snapshot.rows) size = snapshot.columns+':'+snapshot.rows;
        if ((snapshot.output || snapshot.resizes?.length) && container.parentElement !== parking) terminal.refresh(0, Math.max(0, terminal.rows - 1));
        after = snapshot.sequence;
        update(status === 'open' ? null : 'Agent '+status+'. Use Open agent to reconnect.');
        resize();
      });
    } catch (e) { if (!disposed) update(String(e)); }
    finally { if (!disposed && pollEpoch === epoch) timer = setTimeout(poll, status === 'open' ? 120 : 1500); }
  };
  void poll();
  void document.fonts?.ready.then(() => resize());
  return { terminal, container, resize,
    attach(root: HTMLElement) { if (disposed) return; root.appendChild(container); resize(); },
    park() { if (disposed) return; parking.style.width = `${container.clientWidth || 960}px`; parking.style.height = `${container.clientHeight || 600}px`; parking.appendChild(container); },
    restart() {
      epoch += 1; after = 0; status = 'disconnected'; size = ''; clearTimeout(timer);
      const restartEpoch = epoch;
      void enqueue(() => { if (!disposed && restartEpoch === epoch) { terminal.reset(); update(null); } });
      void poll();
    },
    subscribe(listener: (error: string | null) => void) { listeners.add(listener); listener(error); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; clearTimeout(timer); cancelAnimationFrame(frame); input.dispose(); terminal.dispose(); container.remove(); parking.remove(); listeners.clear(); },
  };
}

export function ensureManualTerminal(id: string, restart = false) {
  let engine = engines.get(id);
  if (!engine) { engine = createEngine(id); engines.set(id, engine); }
  else if (restart) engine.restart();
  return engine;
}

export function disposeManualTerminal(id: string) {
  engines.get(id)?.dispose();
  engines.delete(id);
}

export function ManualTerminal({ id, generation = 0 }: { id: string; generation?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const { resolvedTheme, forcedTheme } = useTheme();
  const effectiveTheme = forcedTheme || resolvedTheme;
  useEffect(() => {
    const root = host.current; if (!root) return;
    const engine = ensureManualTerminal(id);
    engine.attach(root);
    const unsubscribe = engine.subscribe(setError);
    const observer = new ResizeObserver(engine.resize); observer.observe(root); engine.resize();
    return () => {
      unsubscribe(); observer.disconnect(); engine.park();
      // Keep parsing native output in Chat, other conversations, and settings.
    };
  }, [id, generation]);
  useEffect(() => {
    ensureManualTerminal(id).terminal.options.theme = {
      background: effectiveTheme === 'light' ? '#ffffff' : '#101114',
      foreground: effectiveTheme === 'light' ? '#202124' : '#e4e4e7',
    };
  }, [id, generation, effectiveTheme]);
  return <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
    {error && <p role="status" className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">{error}</p>}
    <div ref={host} className="min-h-0 flex-1 p-2" aria-label="Interactive agent terminal" />
  </div>;
}
