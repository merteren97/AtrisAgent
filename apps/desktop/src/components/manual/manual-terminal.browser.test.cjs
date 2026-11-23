// Run against `npm run dev -w @atris-agent-code/desktop`:
// TERMINAL_TEST_URL=http://127.0.0.1:1420 node src/components/manual/manual-terminal.browser.test.cjs
// PLAYWRIGHT_MODULE / CHROMIUM_PATH can point to an existing local browser installation.
// Set TERMINAL_NATIVE_REPLAY=1 on Windows to capture and render a real ConPTY TUI.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

async function testProjectAdd(page, url) {
  await page.route(url + '/project-add-preview', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
    <link rel="stylesheet" href="/src/styles/globals.css">
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
    </head><body><div id="project-root"></div></body></html>` }));
  await page.goto(url + '/project-add-preview');
  await page.evaluate(async origin => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const client = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = client.default || client;
    const { CreateWorkspaceDialog } = await import('/src/components/workspace/create-workspace-dialog.tsx');
    const { configureApiRuntime } = await import('/src/lib/api-client.ts');
    const { useWorkspaceStore } = await import('/src/stores/workspace-store.ts');
    configureApiRuntime({ origin });
    const inspections = new Map(), gets = [], posts = [];
    window.__TAURI_INTERNALS__ = { invoke(command, args) {
      if (command === 'inspect_workspace_path') return new Promise((resolve, reject) => inspections.set(args.path, { resolve, reject }));
      throw new Error(`Unexpected Tauri command: ${command}`);
    } };
    const nativeFetch = window.fetch;
    window.fetch = async (input, init) => {
      const pathname = new URL(input).pathname;
      if (pathname === '/api/workspaces' && init?.method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push(body);
        return Response.json({ id: 'new', ...body });
      }
      if (pathname === '/api/workspaces') return new Promise(resolve => gets.push(resolve));
      if (pathname === '/api/manual/conversations') return Response.json([]);
      if (pathname === '/api/workspaces/new' && init?.method === 'DELETE') return new Response(null, { status: 204 });
      return nativeFetch(input, init);
    };
    const refreshes = [];
    window.projectAddTest = {
      inspections, posts,
      startRefresh: () => { refreshes.push(useWorkspaceStore.getState().fetchWorkspaces()); },
      async finishRefresh(index, payload) { gets[index](Response.json(payload)); await refreshes[index]; },
      removeNewProject: () => useWorkspaceStore.getState().removeWorkspace('new'),
    };
    function ProjectPreview() {
      const [open, setOpen] = React.useState(false);
      const { workspaces, activeWorkspaceId } = useWorkspaceStore();
      return React.createElement('main', null,
        React.createElement('button', { onClick: () => setOpen(true) }, 'Add a project'),
        React.createElement('ul', { 'aria-label': 'Projects' }, workspaces.map(workspace => React.createElement('li', {
          key: workspace.id, 'aria-current': workspace.id === activeWorkspaceId ? 'true' : undefined,
        }, workspace.name))),
        React.createElement(CreateWorkspaceDialog, { open, onOpenChange: setOpen }),
      );
    }
    createRoot(document.getElementById('project-root')).render(React.createElement(ProjectPreview));
    window.projectAddTest.startRefresh();
  }, url);
  const openDialog = page.getByRole('button', { name: 'Add a project' });
  const dialog = page.getByRole('dialog');
  const input = dialog.getByRole('textbox');
  const inspect = async pathname => {
    await input.fill(pathname);
    await dialog.getByRole('button', { name: 'Inspect', exact: true }).click();
    await page.waitForFunction(path => window.projectAddTest.inspections.has(path), pathname);
  };
  await openDialog.click();
  await inspect('C:/closed');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await openDialog.click();
  assert.equal(await input.inputValue(), '', 'reopening must reset the cancelled inspection');
  await inspect('C:/old');
  await inspect('C:/chosen');
  await page.evaluate(() => {
    const { inspections } = window.projectAddTest;
    inspections.get('C:/closed').reject('Stale inspection error');
    inspections.get('C:/old').resolve({ path: 'C:/old', name: 'Old project', isGit: false, dirty: false, projectTypes: [] });
  });
  const inspectButton = dialog.getByRole('button', { name: 'Inspect', exact: true });
  assert.equal(await inspectButton.isDisabled(), true, 'older responses must not finish the current inspection');
  assert.equal(await input.inputValue(), 'C:/chosen');
  assert.equal(await dialog.getByText('Stale inspection error').count(), 0);
  await page.evaluate(() => window.projectAddTest.inspections.get('C:/chosen').resolve({
    path: 'C:/canonical', name: 'New project', isGit: true, branch: 'main', dirty: false, projectTypes: [],
  }));
  await dialog.getByRole('button', { name: 'Open workspace' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const items = page.getByRole('list', { name: 'Projects' }).getByRole('listitem');
  await items.filter({ hasText: 'New project' }).waitFor();
  const created = { name: 'New project', path: 'C:/canonical', gitInitialized: true };
  assert.deepEqual(await page.evaluate(() => window.projectAddTest.posts), [created]);
  const existing = { id: 'existing', name: 'Existing project', path: 'C:/existing' };
  await page.evaluate(existing => window.projectAddTest.finishRefresh(0, [existing]), existing);
  await items.filter({ hasText: 'Existing project' }).waitFor();
  assert.deepEqual(await items.allTextContents(), ['New project', 'Existing project'], 'late GET must preserve the created project and hydrate other projects');
  assert.equal(await items.filter({ hasText: 'New project' }).getAttribute('aria-current'), 'true');
  await page.evaluate(async ([created, existing]) => {
    const test = window.projectAddTest;
    test.startRefresh();
    await test.removeNewProject();
    await test.finishRefresh(1, [{ id: 'new', ...created }, existing]);
  }, [created, existing]);
  await page.waitForFunction(() => document.querySelector('[aria-current="true"]')?.textContent === 'Existing project');
  assert.deepEqual(await items.allTextContents(), ['Existing project'], 'late GET must not resurrect a deleted project');
  console.log('PASS: project add, stale folder inspections, and late workspace GET across create/delete');
}

async function testManualTrustAndChanges(page, url) {
  await page.route(url + '/manual-review-preview', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
    <link rel="stylesheet" href="/src/styles/globals.css">
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
    </head><body><div id="manual-root" style="display:flex;height:65vh"></div><div id="review-root" style="height:35vh"></div></body></html>` }));
  await page.goto(url + '/manual-review-preview');
  await page.evaluate(async origin => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const client = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = client.default || client;
    const { configureApiRuntime } = await import('/src/lib/api-client.ts');
    const { useManualStore } = await import('/src/stores/manual-store.ts');
    const { useWorkspaceStore } = await import('/src/stores/workspace-store.ts');
    const { ManualWorkspace } = await import('/src/components/manual/manual-workspace.tsx');
    const { ChangesList } = await import('/src/components/dock/ChangesPanel.tsx');
    configureApiRuntime({ origin });
    const workspace = { id: 'sample', name: 'Fixture', path: 'C:/fixture' };
    const agent = { id: 'agy-fixture', conversationId: 'review', runtimeType: 'antigravity', name: 'Antigravity 1', cwd: workspace.path };
    useWorkspaceStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
    useManualStore.setState({ mode: 'manual', activeByWorkspace: {sample: 'review'}, conversations: { sample: [{ id: 'review', workspaceId: 'sample', title: 'Fixture conversation', agents: [agent] }] } });
    const recorded = window.manualReview = { writes: [], refreshes: [], actions: [], cwd: null, ready: false, questions: [] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Send must not use the clipboard'); } } });
    let started = false;
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'manual_terminal_start') { started = true; recorded.cwd = args.request.cwd; return; }
      if (command === 'manual_terminal_snapshot') return { id: agent.id, status: started ? 'open' : 'disconnected', sequence: started ? 1 : 0,
        output: '', reset: !started, rows: 30, columns: 120, resizes: [], inputReady: recorded.ready };
      if (command === 'manual_terminal_write') {
        if (args.paste && !recorded.ready) throw new Error('Antigravity is not ready. Check Code.');
        recorded.writes.push(args);
      }
    } };
    let pendingFiles = [
      { path: 'a.ts', state: 'pending', revision: 'fixture-revision-a', status: 'modified', restorable: true },
      { path: 'b.ts', state: 'pending', revision: 'fixture-revision-b', status: 'added', restorable: true },
    ];
    const fetch = window.fetch;
    window.fetch = async (input, options) => {
      const u = new URL(input);
      if (u.origin !== origin) throw new Error('Unexpected external request');
      if (u.pathname.endsWith('/launch')) return Response.json({ id: agent.id, cwd: agent.cwd, runtimeType: agent.runtimeType });
      if (u.pathname.endsWith('/turn-started')) return new Response(null, { status: 204 });
      if (u.pathname.endsWith('/changes/resolve')) {
        const action = JSON.parse(options.body); recorded.actions.push(action);
        const completed = action.files.map(item => item.path);
        pendingFiles = pendingFiles.filter(item => !completed.includes(item.path));
        return Response.json({ completed, conflicts: [] });
      }
      if (u.pathname.endsWith('/changes/file')) return Response.json({ before: 'before\n', after: 'after\n' });
      if (u.pathname.endsWith('/changes')) {
        recorded.refreshes.push(u.searchParams.get('refresh'));
        return Response.json({ mode: 'project', files: pendingFiles });
      }
      if (u.pathname.endsWith('/messages')) return Response.json({ revision: `fixture-${recorded.questions.length}`, messages: [], questions: recorded.questions, supported: true, bound: true });
      if (u.pathname.startsWith('/api/')) return Response.json({});
      return fetch(input, options);
    };
    createRoot(document.getElementById('manual-root')).render(React.createElement(ManualWorkspace));
    createRoot(document.getElementById('review-root')).render(React.createElement(ChangesList, { root: '/manual/conversations/review/changes' }));
  }, url);
  await page.getByRole('button', { name: 'Open agent', exact: true }).click();
  const code = page.getByRole('button', { name: 'Code', exact: true });
  const chat = page.getByRole('button', { name: 'Chat', exact: true });
  const draft = page.getByRole('textbox', { name: 'Message Antigravity 1' });
  const testPrompt = Array.from({ length: 120 }, (_, index) => `Fixture line ${index}: Çok satırlı bir mesajı Chat üzerinden gönder.`).join('\n');
  await draft.fill(testPrompt);
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await send.click();
  await page.getByRole('alert').getByText('Antigravity is not ready. Check Code.').waitFor();
  assert.equal(await draft.inputValue(), testPrompt);
  assert.deepEqual(await page.evaluate(() => window.manualReview.writes), []);
  await page.evaluate(() => { window.manualReview.ready = true; });
  await send.click();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message Antigravity 1"]')?.value === '');
  assert.equal(await chat.getAttribute('aria-pressed'), 'true');
  assert.equal(await code.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(await page.evaluate(() => ({ cwd: window.manualReview.cwd, writes: window.manualReview.writes })), {
    cwd: 'C:/fixture', writes: [{ id: 'agy-fixture', data: testPrompt, paste: true }],
  });
  // Verify Antigravity interactive questions can be answered from Chat even while inputReady is false.
  await page.evaluate(() => {
    window.manualReview.ready = false;
    window.manualReview.writes = [];
    window.manualReview.questions = [{
      id: 'q-agy-1',
      questions: [
        { header: 'Question 1/2', question: 'Pick style', options: [{ label: 'Minimal' }, { label: 'Mission Control' }] },
        { header: 'Question 2/2', question: 'Pick language', options: [{ label: 'English' }, { label: 'Turkish' }] },
      ],
    }];
  });
  await page.getByLabel('Agent question').waitFor({ timeout: 5000 });
  await page.getByLabel('Mission Control').click();
  await page.getByLabel('Turkish').click();
  await page.getByRole('button', { name: 'Submit answers', exact: true }).click();
  await page.waitForFunction(() => window.manualReview.writes.length === 2);
  assert.deepEqual(await page.evaluate(() => window.manualReview.writes), [
    { id: 'agy-fixture', data: '\u001b[B\r', paste: false },
    { id: 'agy-fixture', data: '\u001b[B\r', paste: false },
  ]);
  const review = page.locator('#review-root');
  await review.getByRole('button', { name: 'Refresh changes' }).click();
  await page.waitForFunction(() => window.manualReview.refreshes.includes('1'));
  await review.getByRole('button', { name: /a\.ts/ }).click();
  await review.getByLabel('Code comparison').getByText('after', { exact: true }).filter({ visible: true }).waitFor();
  await review.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('button', { name: 'Approve changes', exact: true }).click();
  await review.getByText('Approved: 1', { exact: true }).waitFor();
  await review.getByRole('button', { name: /b\.ts/ }).click();
  await review.getByRole('button', { name: 'Undo file', exact: true }).click();
  await page.getByRole('button', { name: 'Undo changes', exact: true }).click();
  await review.getByText('No changes yet', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.manualReview.actions), [
    { action: 'approve', files: [{ path: 'a.ts', revision: 'fixture-revision-a' }] },
    { action: 'undo', files: [{ path: 'b.ts', revision: 'fixture-revision-b' }] },
  ]);
  // Verify Latest messages button is horizontally centered above Changed files (when present) and above composer (when absent).
  await page.evaluate(() => {
    window.manualReview.questions = [];
    const container = document.querySelector('#manual-root [class*="overflow-y-auto"]');
    if (container && container.firstElementChild) {
      for (let i = 0; i < 30; i++) {
        const p = document.createElement('p');
        p.textContent = `Filler line ${i} for scroll test`;
        p.style.height = '40px';
        container.firstElementChild.appendChild(p);
      }
      container.scrollTop = 0;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  });
  const latestBtn = page.locator('#manual-root').getByRole('button', { name: /Latest messages/i });
  await latestBtn.waitFor({ timeout: 5000 });
  const centeredCheck = await page.evaluate(() => {
    const viewport = document.querySelector('#manual-root [class*="overflow-y-auto"]');
    const btn = Array.from(document.querySelectorAll('#manual-root button')).find(b => /Latest messages/i.test(b.textContent || ''));
    const composer = document.querySelector('#manual-root form');
    if (!viewport || !btn || !composer) return null;
    const vr = viewport.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const cr = composer.getBoundingClientRect();
    return {
      centerDelta: Math.abs((br.left + br.width / 2) - (vr.left + vr.width / 2)),
      aboveComposer: br.bottom <= cr.top + 2,
    };
  });
  assert.ok(centeredCheck && centeredCheck.centerDelta < 4 && centeredCheck.aboveComposer, `Expected centered Latest messages button above composer, got ${JSON.stringify(centeredCheck)}`);
  console.log('PASS: Antigravity Chat send + question reply work, Latest messages is centered above composer/changed-files, and conversation Approve/Undo clear reviewed files');
}

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
      const until = async (predicate, timeout) => {
        const deadline = performance.now() + timeout;
        while (!predicate() && performance.now() < deadline) await sleep(15);
        return predicate();
      };
      let sequence = 0;
      let status = 'open';
      let geometry = { columns: 120, rows: 30 };
      const chunks = [];
      const calls = [];
      let speculativeResizes = 0;
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
          if (engine.terminal.cols !== geometry.columns || engine.terminal.rows !== geometry.rows) speculativeResizes += 1;
          // Output emitted after the last poll but before native resize must be
          // interpreted on the old grid, without a speculative A→B→A transition.
          append('\x1b[2;1HLATE-old-grid');
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
      const snapshotCount = () => calls.filter(call => call.command === 'manual_terminal_snapshot' && !call.statusOnly).length;
      const sampleMs = 1450;
      const visibleStart = snapshotCount();
      await sleep(sampleMs);
      const visiblePolls = snapshotCount() - visibleStart;
      const parkedStart = snapshotCount();
      engine.park();
      // The detached CLI still needs the emulator to parse output and answer a DSR.
      append('\x1b[3;1H\x1b[2KPARKED-output\x1b[6n');
      await sleep(sampleMs);
      const parkedPolls = snapshotCount() - parkedStart;
      const parkedOutput = screen().lines[2];
      const parkedCursorReply = calls.some(call => call.command === 'manual_terminal_write' && /^\x1b\[3;\d+R$/.test(call.data));
      // Reveal just after a parked snapshot, while the next slow tick is far away.
      const beforeLastParkedPoll = snapshotCount();
      if (!await until(() => snapshotCount() > beforeLastParkedPoll, 1500)) throw new Error('Parked snapshots stopped');
      append('\x1b[4;1H\x1b[2KREVEAL-output');
      const revealStart = performance.now();
      engine.attach(document.querySelector('#host'));
      const revealCaughtUp = await until(() => screen().lines[3] === 'REVEAL-output', 400);
      const revealCatchUpMs = Math.round(performance.now() - revealStart);
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
      window.terminalTestResult = { live, replayed, raced, revealResizes, resetsDuringWrite, closedRows, closedResizes, speculativeResizes,
        sampleMs, visiblePolls, parkedPolls, parkedOutput, parkedCursorReply, revealCaughtUp, revealCatchUpMs };
      window.disposeTerminalTest = () => disposeManualTerminal('replay-test');
      return window.terminalTestResult;
    });
    console.log(JSON.stringify({ grid: `${result.live.cols}x${result.live.rows}`, revealResizes: result.revealResizes,
      resetsDuringWrite: result.resetsDuringWrite, sampleMs: result.sampleMs, visiblePolls: result.visiblePolls,
      parkedPolls: result.parkedPolls, revealCatchUpMs: result.revealCatchUpMs }));
    if (process.env.TERMINAL_SCREENSHOT) await page.screenshot({ path: process.env.TERMINAL_SCREENSHOT });
    assert.deepEqual(result.replayed, result.live, 'replaying a resized TUI must reproduce its live screen');
    assert.deepEqual(result.raced, result.live, 'an old in-flight snapshot must not contaminate restart');
    assert.equal(result.revealResizes, 0, 'same-size reveal must not resize/reprint the PTY');
    assert.ok(result.parkedPolls >= 1 && result.parkedPolls * 3 <= result.visiblePolls, 'parked full snapshots must continue at no more than one third of the visible cadence');
    assert.equal(result.parkedOutput, 'PARKED-output', 'parked output must reach the real xterm buffer');
    assert.equal(result.parkedCursorReply, true, 'the parked emulator must still send cursor replies to the PTY');
    assert.equal(result.revealCaughtUp, true, 'revealing must catch up without waiting for the next parked tick');
    assert.equal(result.speculativeResizes, 0, 'unread old-grid output must precede the emulator resize');
    assert.equal(result.resetsDuringWrite, 0, 'restart must not reset xterm while a previous frame is still parsing');
    assert.equal(result.closedRows, 30, 'an exited terminal must still fit its visible pane');
    assert.equal(result.closedResizes, 0, 'fitting an exited terminal must not resize a native session');
    assert.equal(result.live.lines[0], 'HEADER');
    assert.match(result.live.lines.at(-1), /^FOOTER-\d+x\d+$/);
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.disposeTerminalTest());
    assert.equal(await page.locator('#host').evaluate(host => host.children.length), 0, 'dispose must remove the attached full-height container');
    console.log('PASS: real xterm replay, restart race, parked cadence and cursor replies, instant same-size reveal, header/footer geometry');
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
    await testProjectAdd(page, url);
    await testManualTrustAndChanges(page, url);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); if(server)server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
