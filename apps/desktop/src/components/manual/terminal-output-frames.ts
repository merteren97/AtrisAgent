const START = '\x1b[?2026h';
const END = '\x1b[?2026l';
const MAX_FRAME = 1024 * 1024;
const MAX_WAIT_MS = 250;

/** xterm 5 does not implement synchronized-output mode. Keep a CLI's clear and
 * repaint in one write, even when ConPTY/polling splits it across snapshots. */
export class TerminalOutputFrames {
  private pending = '';
  private active = false;
  private since = 0;

  push(text: string, now = performance.now()): string {
    let source = this.pending + text;
    this.pending = '';
    let ready = '';
    while (source) {
      if (this.active) {
        const end = source.indexOf(END);
        if (end < 0) { this.pending = source; break; }
        ready += source.slice(0, end + END.length);
        source = source.slice(end + END.length);
        this.active = false; this.since = 0;
      } else {
        const start = source.indexOf(START);
        if (start >= 0) {
          ready += source.slice(0, start);
          source = source.slice(start);
          this.active = true; this.since = now;
        } else {
          // Retain only a possible split START escape, not arbitrary CLI output.
          let suffix = Math.min(START.length - 1, source.length);
          while (suffix && !START.startsWith(source.slice(-suffix))) suffix--;
          ready += source.slice(0, source.length - suffix);
          this.pending = source.slice(source.length - suffix);
          if (suffix && !this.since) this.since = now;
          if (!suffix) this.since = 0;
          break;
        }
      }
    }
    if (this.pending.length > MAX_FRAME) ready += this.flush();
    return ready;
  }

  flushExpired(now = performance.now()): string {
    return this.pending && now - this.since >= MAX_WAIT_MS ? this.flush() : '';
  }

  flush(): string {
    const text = this.pending;
    this.reset();
    return text;
  }

  reset(): void { this.pending = ''; this.active = false; this.since = 0; }
}
