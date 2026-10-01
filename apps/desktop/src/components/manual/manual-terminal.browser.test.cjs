// Run against `npm run dev -w @atris-agent-code/desktop`:
// TERMINAL_TEST_URL=http://127.0.0.1:1420 node src/components/manual/manual-terminal.browser.test.cjs
// PLAYWRIGHT_MODULE / CHROMIUM_PATH can point to an existing local browser installation.
// Set TERMINAL_NATIVE_REPLAY=1 on Windows to capture and render a real ConPTY TUI.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
  const url = process.env.TERMINAL_TEST_URL || 'http://127.0.0.1:1420';
  const errors = [];
  let server;
  page.on('pageerror', error => errors.push(error.message));
  try {
    if(process.env.TERMINAL_START_SERVER==='1'){
      server=spawn(process.execPath,[path.resolve(__dirname,'../../../../../node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',new URL(url).port,'--strictPort'],{cwd:path.resolve(__dirname,'../../..'),stdio:'ignore'});
      let ready=false;
      for(let attempt=0;attempt<300;attempt++){
        try{const response=await fetch(url+'/src/components/manual/manual-terminal.tsx');await response.text();if(response.ok){ready=true;break;}}catch{}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert.ok(ready,'The isolated terminal preview did not start');
    }
    await page.route(url + '/', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
      <style>body{margin:0;background:#101114;color:white}.h-full{height:100%}.w-full{width:100%}</style>
      <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
      </head><body><div id="host" style="width:450px;height:700px"></div></body></html>` }));
    await page.goto(url + '/');
    const result = await page.evaluate(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      let sequence = 0;
      let status = 'open';
      let geometry = { columns: 120, rows: 30 };
      const chunks = [];
      const calls = [];
      const append = (output, size = geometry) => chunks.push({ sequence: ++sequence, output, ...size });
      // A main-screen TUI with wrapped transcript, a pinned header and footer.
      // Resize repaint is a delta, as with a ConPTY screen dump, not a clear/reset.
      const transcript = 'TRANSCRIPT '.repeat(28);
      append('\x1b[2J\x1b[2;1H' + transcript + '\x1b[30;1HFOOTER-old\x1b[1;1H\x1b[2KHEADER');
      let pendingSnapshot;
      let pause = false;
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        calls.push({ command, ...args });
        if (command === 'manual_terminal_resize') {
          if (geometry.columns === args.columns && geometry.rows === args.rows) return;
          const oldRows = geometry.rows;
          geometry = { columns: args.columns, rows: args.rows };
          append('', geometry);
          append(`\x1b[${oldRows};1H\x1b[2K\x1b[${geometry.rows};1HFOOTER-${geometry.columns}x${geometry.rows}\x1b[1;1H\x1b[2KHEADER`);
          return;
        }
        if (command === 'manual_terminal_snapshot') {
          if (pause) await new Promise(resolve => { pendingSnapshot = resolve; });
          const pending = chunks.filter(chunk => chunk.sequence > args.after);
          const resizes = [];
          let output = '', key = '';
          for (const chunk of pending) {
            const next = `${chunk.columns}:${chunk.rows}`;
            if (next !== key) { resizes.push({ offset: output.length, columns: chunk.columns, rows: chunk.rows }); key = next; }
            output += chunk.output;
          }
          return { id: args.id, status, sequence, output, reset: false, ...geometry, resizes };
        }
      }};
      const { ensureManualTerminal, disposeManualTerminal } = await import('/src/components/manual/manual-terminal.tsx');
      const engine = ensureManualTerminal('replay-test');
      engine.attach(document.querySelector('#host'));
      await sleep(400);
      const screen = () => {
        const buffer = engine.terminal.buffer.active;
        return { cols: engine.terminal.cols, rows: engine.terminal.rows, baseY: buffer.baseY, viewportY: buffer.viewportY,
          lines: Array.from({ length: engine.terminal.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) || '') };
      };
      const live = screen();
      // Reconnect must reconstruct the same live grid, including the old 120x30 frame.
      engine.restart();
      await sleep(1700);
      const replayed = screen();
      // Hide/reveal at the same size must not ask ConPTY to resize/reprint.
      const resizeCount = calls.filter(call => call.command === 'manual_terminal_resize').length;
      engine.park(); engine.attach(document.querySelector('#host'));
      await sleep(250);
      const revealResizes = calls.filter(call => call.command === 'manual_terminal_resize').length - resizeCount;
      // Reset while a snapshot is in flight must not let old output into the new epoch.
      pause = true;
      await sleep(200);
      engine.restart();
      pause = false;
      pendingSnapshot?.();
      await sleep(1700);
      const raced = screen();
      // A reset must wait for the actual xterm parse callback, not just snapshot IPC.
      let deferredWrite, writePending = true, resetsDuringWrite = 0;
      const originalWrite = engine.terminal.write.bind(engine.terminal);
      const originalReset = engine.terminal.reset.bind(engine.terminal);
      engine.terminal.write = (text, callback) => {
        if (writePending) deferredWrite = () => originalWrite(text, () => { writePending = false; callback?.(); });
        else originalWrite(text, callback);
      };
      engine.terminal.reset = () => { if (writePending) resetsDuringWrite += 1; originalReset(); };
      append('\x1b[2;1HSTALE-write');
      for (let attempt = 0; !deferredWrite && attempt < 30; attempt += 1) await sleep(20);
      if (!deferredWrite) throw new Error('xterm write did not start');
      engine.restart(); await sleep(50);
      deferredWrite(); await sleep(300);
      engine.terminal.write = originalWrite; engine.terminal.reset = originalReset;
      status = 'exited'; await sleep(200);
      const beforeClosedFit = calls.filter(call => call.command === 'manual_terminal_resize').length;
      document.querySelector('#host').style.height = '450px'; engine.resize(); await sleep(200);
      const closedRows = engine.terminal.rows;
      const closedResizes = calls.filter(call => call.command === 'manual_terminal_resize').length - beforeClosedFit;
      window.terminalTestResult = { live, replayed, raced, revealResizes, resetsDuringWrite, closedRows, closedResizes, calls };
      window.disposeTerminalTest = () => disposeManualTerminal('replay-test');
      return window.terminalTestResult;
    });
    console.log(JSON.stringify({ grid: `${result.live.cols}x${result.live.rows}`, revealResizes: result.revealResizes, resetsDuringWrite: result.resetsDuringWrite }));
    if (process.env.TERMINAL_SCREENSHOT) await page.screenshot({ path: process.env.TERMINAL_SCREENSHOT });
    assert.deepEqual(result.replayed, result.live, 'replaying a resized TUI must reproduce its live screen');
    assert.deepEqual(result.raced, result.live, 'an old in-flight snapshot must not contaminate restart');
    assert.equal(result.revealResizes, 0, 'same-size reveal must not resize/reprint the PTY');
    assert.equal(result.resetsDuringWrite, 0, 'restart must not reset xterm while a previous frame is still parsing');
    assert.equal(result.closedRows, 30, 'an exited terminal must still fit its visible pane');
    assert.equal(result.closedResizes, 0, 'fitting an exited terminal must not resize a native session');
    assert.equal(result.live.lines[0], 'HEADER');
    assert.match(result.live.lines.at(-1), /^FOOTER-\d+x\d+$/);
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.disposeTerminalTest());
    assert.equal(await page.locator('#host').evaluate(host => host.children.length), 0, 'dispose must remove the attached full-height container');
    console.log('PASS: real xterm replay, restart race, same-size reveal, header/footer geometry');
    if (process.env.TERMINAL_OPENCODE_REPLAY) {
      const fixture = JSON.parse(fs.readFileSync(process.env.TERMINAL_OPENCODE_REPLAY, 'utf8'));
      const rendered = await page.evaluate(async fixture => {
        document.querySelector('#host').style.height = '700px';
        window.__TAURI_INTERNALS__ = { invoke: async (command, args) => command === 'manual_terminal_snapshot'
          ? (args.after === 0 ? fixture : {...fixture, output:'',resizes:[]}) : undefined };
        const {ensureManualTerminal,disposeManualTerminal} = await import('/src/components/manual/manual-terminal.tsx');
        const engine = ensureManualTerminal('installed-opencode');
        engine.attach(document.querySelector('#host'));
        await new Promise(resolve=>setTimeout(resolve,600));
        const buffer = engine.terminal.buffer.active;
        const lines = Array.from({length:engine.terminal.rows},(_,row)=>buffer.getLine(buffer.baseY+row)?.translateToString(true)||'');
        window.disposeTerminalTest = ()=>disposeManualTerminal('installed-opencode');
        return {lines,columns:engine.terminal.cols,rows:engine.terminal.rows};
      }, fixture);
      assert.ok(rendered.lines.some(line=>line.includes('Atris test')&&line.includes('low')), 'The rendered installed OpenCode footer must show the actual selected reasoning');
      assert.deepEqual(errors,[]);
      if(process.env.TERMINAL_SCREENSHOT)await page.screenshot({path:process.env.TERMINAL_SCREENSHOT});
      await page.evaluate(()=>window.disposeTerminalTest());
      console.log('PASS: rendered installed OpenCode ConPTY output with confirmed low reasoning at '+rendered.columns+'x'+rendered.rows);
    }
    if (process.env.TERMINAL_NATIVE_REPLAY === '1') {
      const output = execFileSync('cargo', ['test', '--lib', 'manual_terminal::tests::real_pty_resize_replay_retains_screen_geometry', '--', '--nocapture'], {
        cwd: path.resolve(__dirname, '../../../src-tauri'), encoding: 'utf8', timeout: 120000,
      });
      const fixture = JSON.parse(output.split('\n').find(line => line.startsWith('TERMINAL_NATIVE_FIXTURE=')).slice('TERMINAL_NATIVE_FIXTURE='.length));
      const native = await page.evaluate(async fixture => {
        let resized = false, legacy = false;
        document.querySelector('#host').style.height = '300px';
        window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
          if (command === 'manual_terminal_resize') { resized = true; return; }
          if (command !== 'manual_terminal_snapshot') return;
          let snapshot = args.after === 0 ? (resized ? fixture.replay : fixture.initial)
            : args.after === fixture.initial.sequence ? fixture.narrow
            : { ...fixture.replay, output: '', resizes: [] };
          return legacy ? { ...snapshot, resizes: undefined } : snapshot;
        }};
        const { ensureManualTerminal, disposeManualTerminal } = await import('/src/components/manual/manual-terminal.tsx');
        const engine = ensureManualTerminal('native-replay-test');
        engine.attach(document.querySelector('#host'));
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const screen = () => {
          const buffer = engine.terminal.buffer.active;
          return { cols: engine.terminal.cols, rows: engine.terminal.rows, baseY: buffer.baseY, viewportY: buffer.viewportY,
            lines: Array.from({ length: engine.terminal.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) || '') };
        };
        await sleep(400);
        const live = screen();
        engine.restart(); await sleep(400);
        const replayed = screen();
        // Reproduce the former text-only replay using the exact same real ConPTY bytes.
        legacy = true;
        engine.restart(); await sleep(400);
        const textOnly = screen();
        legacy = false;
        engine.restart(); await sleep(400);
        window.disposeTerminalTest = () => disposeManualTerminal('native-replay-test');
        return { live, replayed, textOnly };
      }, fixture);
      console.log(JSON.stringify({ native: { grid: `${native.live.cols}x${native.live.rows}`, liveBaseY: native.live.baseY,
        replayBaseY: native.replayed.baseY, textOnlyBaseY: native.textOnly.baseY, header: native.live.lines[0], footer: native.live.lines.at(-1) } }));
      assert.deepEqual(native.replayed, native.live, 'actual ConPTY replay must reproduce the live screen');
      assert.notDeepEqual(native.textOnly, native.live, 'actual ConPTY bytes must reproduce the former geometry defect');
      assert.equal(native.live.lines[0], 'HEADER-57x20');
      assert.equal(native.live.lines.at(-1), 'FOOTER-57x20');
      assert.ok(!native.live.lines.some(line => line.includes('FOOTER-120x30')));
      if (process.env.TERMINAL_SCREENSHOT) await page.screenshot({ path: process.env.TERMINAL_SCREENSHOT });
      await page.evaluate(() => window.disposeTerminalTest());
      console.log('PASS: captured Windows ConPTY TUI bytes; former text-only replay fails, geometry-aware replay matches live');
    }
  } finally { await browser.close(); if(server)server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
