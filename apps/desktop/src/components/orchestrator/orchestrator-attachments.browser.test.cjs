// Run against the desktop Vite dev server. Uses existing Playwright tooling, no added dependency.
// ATTACHMENTS_TEST_URL=http://127.0.0.1:4317 PLAYWRIGHT_MODULE=/path/to/playwright-core CHROMIUM_PATH=/path/to/chrome
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } });
  const origin = process.env.ATTACHMENTS_TEST_URL || 'http://127.0.0.1:1420';
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.route(`${origin}/attachment-preview`, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/styles/globals.css"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div></body></html>` }));
    await page.goto(`${origin}/attachment-preview`);
    await page.evaluate(async (origin) => {
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const client = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { createRoot } = client.default || client;
      const { OrchestratorAttachmentTray, useOrchestratorAttachments } = await import('/src/components/orchestrator/orchestrator-attachments.tsx');
      const { MessageCard } = await import('/src/components/chat/message-card.tsx');
      const { configureApiRuntime } = await import('/src/lib/api-client.ts');
      const { setAuthToken } = await import('/src/lib/token-provider.ts');
      configureApiRuntime({ origin, runtimeToken: 'preview-runtime' });
      setAuthToken('preview-user');
      const canvas = document.createElement('canvas');
      canvas.width = 480; canvas.height = 240;
      const context = canvas.getContext('2d');
      context.fillStyle = '#224534'; context.fillRect(0, 0, 480, 240);
      context.fillStyle = '#ffffff'; context.font = '28px sans-serif'; context.fillText('Attachment reference', 32, 125);
      const png = canvas.toDataURL('image/png').split(',')[1];
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
      const ref = { id: 'saved-file', workspaceId: 'preview-workspace', name: 'Saved screenshot.png', mimeType: 'image/png', byteSize: bytes.length, sha256: 'hash', createdAt: 'now' };
      const nativeFetch = window.fetch;
      window.__attachmentCalls = [];
      window.__createdURLs = [];
      window.__revokedURLs = [];
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { const url = create(blob); window.__createdURLs.push(url); return url; };
      URL.revokeObjectURL = (url) => { window.__revokedURLs.push(url); revoke(url); };
      window.fetch = (url, init) => {
        if (String(url).includes('/api/attachments/')) {
          window.__attachmentCalls.push({ url: String(url), auth: new Headers(init?.headers).get('Authorization'), runtime: new Headers(init?.headers).get('X-Atris-Runtime-Token') });
          return Promise.resolve(new Response(JSON.stringify({ ...ref, dataBase64: png }), { headers: { 'content-type': 'application/json' } }));
        }
        return nativeFetch(url, init);
      };
      // Browser-generated empty MIME uses extension inference for its tray thumbnail.
      const files = [new File([bytes], 'Screenshot.png', { lastModified: 1 }), new File(['Notes'], 'Notes.md', { lastModified: 2 })];
      function Harness() {
        const [scope, setScope] = React.useState('conversation:one');
        const attachments = useOrchestratorAttachments(scope, 'preview-workspace');
        window.__hook = attachments;
        React.useEffect(() => {
          if (!window.__seeded) { window.__seeded = true; attachments.addFiles(files); }
        }, []);
        return React.createElement('main', { className: 'mx-auto max-w-3xl p-6' },
          React.createElement('h1', { className: 'mb-4 text-lg font-semibold' }, 'Attachment preview'),
          React.createElement('button', { onClick: () => setScope(scope === 'conversation:one' ? 'draft:two' : 'conversation:one') }, 'Switch scope'),
          React.createElement('div', { className: 'mt-3 rounded-2xl border border-border bg-card p-3' }, React.createElement(OrchestratorAttachmentTray, { files: attachments.files, onRemove: attachments.removeFile })),
          React.createElement(MessageCard, { role: 'user', content: 'Inspect the attached files.', timestamp: '12:00', metadata: { attachmentIds: ['saved-file'] }, workspaceId: 'preview-workspace' }));
      }
      window.__root = createRoot(document.getElementById('root'));
      window.__root.render(React.createElement(Harness));
    }, origin);
    await page.getByRole('button', { name: 'Preview Screenshot.png', exact: true }).waitFor();
    await page.getByRole('img', { name: 'Saved screenshot.png', exact: true }).waitFor();
    const calls = await page.evaluate(() => window.__attachmentCalls);
    assert.equal(calls.length, 1);
    assert(calls[0].url.endsWith('/attachments/saved-file?workspaceId=preview-workspace'));
    assert.equal(calls[0].auth, 'Bearer preview-user', 'reloaded previews use authenticated transport');
    assert.equal(calls[0].runtime, 'preview-runtime');
    await page.getByRole('button', { name: 'Preview Screenshot.png', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('dialog').getByRole('img').count(), 1);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Preview Screenshot.png');
    assert.equal(await page.getByRole('button', { name: 'Preview Screenshot.png', exact: true }).evaluate((element) => element === document.activeElement), true, 'lightbox restores keyboard focus');
    await page.getByRole('button', { name: 'Preview Saved screenshot.png', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('dialog').getByRole('img').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal((await page.evaluate(() => window.__attachmentCalls)).length, 1, 'lightbox reuses preview bytes');
    await page.getByRole('button', { name: 'Switch scope', exact: true }).click();
    await page.getByRole('button', { name: 'Preview Screenshot.png', exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Switch scope', exact: true }).click();
    await page.getByRole('button', { name: 'Preview Screenshot.png', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Remove Notes.md', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Preview Notes.md', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.__hook.files.length), 1);
    if (process.env.ATTACHMENTS_SCREENSHOT) await page.screenshot({ path: process.env.ATTACHMENTS_SCREENSHOT });
    await page.setViewportSize({ width: 420, height: 750 });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'tray/message remain within a constrained window');
    if (process.env.ATTACHMENTS_DARK_SCREENSHOT) await page.screenshot({ path: process.env.ATTACHMENTS_DARK_SCREENSHOT });
    await page.evaluate(() => window.__root.unmount());
    assert.equal(await page.evaluate(() => window.__createdURLs.every((url) => window.__revokedURLs.includes(url))), true, 'all tray and fetched preview object URLs are cleaned up');
    assert.deepEqual(errors, []);
    console.log('Attachment tray/hook/reload/auth/lightbox/focus/cleanup browser tests passed.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
