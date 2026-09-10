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
  // xterm must measure fonts in a connected, sized element, including background startup.
  const parking = document.createElement('div');
  parking.setAttribute('aria-hidden', 'true');
  Object.assign(parking.style, { position: 'fixed', left: '-10000px', top: '0', width: '960px', height: '600px', visibility: 'hidden', pointerEvents: 'none' });
  document.body.appendChild(parking); parking.appendChild(container);
  const terminal = new Terminal({ cols: 120, rows: 30, cursorBlink: true, fontSize: 13,
    fontFamily: 'Cascadia Mono, Consolas, monospace', scrollback: 5000, allowProposedApi: false,
    // ConPTY already performs wrapping. Normal Unix reflow can duplicate or
    // scatter a full-screen CLI when panes change size (same policy as AtrisWork).
    windowsPty: /Windows/i.test(navigator.userAgent) ? { backend: 'conpty' } : undefined });
  const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container);
  let disposed = false; let after = 0; let status = 'disconnected'; let size = ''; let epoch = 0;
  let error: string | null = null; let timer: ReturnType<typeof setTimeout>;
  let writes = Promise.resolve();
  let resizing = false; let frame = 0;
  const listeners = new Set<(error: string | null) => void>();
  const update = (value: string | null) => { error = value; listeners.forEach(listener => listener(error)); };
  const flushResize = async () => {
    if (resizing || disposed || status !== 'open' || container.parentElement === parking) return;
    resizing = true;
    try {
      while (!disposed && status === 'open') {
        const next = terminal.cols+':'+terminal.rows;
        if (next === size) break;
        const resizeEpoch = epoch;
        await invoke('manual_terminal_resize', { id, columns: terminal.cols, rows: terminal.rows });
        if (resizeEpoch !== epoch) break;
        size = next;
      }
    } catch (e) { if (!disposed) update(String(e)); }
    finally { resizing = false; }
  };
  const resize = () => {
    if (frame || disposed || container.parentElement === parking) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (disposed || container.parentElement === parking || !container.clientWidth || !container.clientHeight) return;
      const proposed = fit.proposeDimensions();
      if (!proposed) return;
      // Keep emulator dimensions identical to the native PTY's safety limits.
      const cols = Math.min(500, Math.max(2, proposed.cols)), rows = Math.min(300, Math.max(2, proposed.rows));
      if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
      void flushResize();
    });
  };
  const input = terminal.onData(data => {
    if (status !== 'open') return;
    writes = writes.then(() => disposed ? undefined : invoke<void>('manual_terminal_write', { id, data, paste: false })).catch(e => { if (!disposed) update(String(e)); });
  });
  const poll = async () => {
    const pollEpoch = epoch;
    try {
      const snapshot = await invoke<TerminalSnapshot>('manual_terminal_snapshot', { id, after });
      if (disposed || pollEpoch !== epoch) return;
      status = snapshot.status;
      if (snapshot.reset) terminal.reset();
      after = snapshot.sequence;
      if (snapshot.output) await new Promise<void>(resolve => terminal.write(snapshot.output, resolve));
      if (disposed || pollEpoch !== epoch) return;
      update(status === 'open' ? null : 'Agent '+status+'. Use Open agent to reconnect.');
      resize();
    } catch (e) { if (!disposed) update(String(e)); }
    finally { if (!disposed) timer = setTimeout(poll, status === 'open' ? 120 : 1500); }
  };
  void poll();
  void document.fonts?.ready.then(() => resize());
  return { terminal, container, resize,
    attach(root: HTMLElement) { if (disposed) return; root.appendChild(container); size = ''; resize(); },
    park() { if (disposed) return; parking.style.width = `${container.clientWidth || 960}px`; parking.style.height = `${container.clientHeight || 600}px`; parking.appendChild(container); },
    restart() { epoch += 1; after = 0; status = 'disconnected'; size = ''; terminal.reset(); update(null); },
    subscribe(listener: (error: string | null) => void) { listeners.add(listener); listener(error); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; clearTimeout(timer); cancelAnimationFrame(frame); input.dispose(); terminal.dispose(); parking.remove(); listeners.clear(); },
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
