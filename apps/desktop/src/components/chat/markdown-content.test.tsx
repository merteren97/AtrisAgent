import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent, normalizeFileUri } from './markdown-content';
import { detectImageMime, loadLocalImagePreviewBlob, normalizeImagePath } from './chat-image-preview';
import { configureApiRuntime } from '@/lib/api-client';
import { browserUrl, useBrowserStore } from '@/stores/browser-store';

const render = (content: string) => renderToStaticMarkup(<MarkdownContent content={content} />);

const table = render('Intro\n| Name | Result |\n| :--- | ---: |\n| **Agent** | `ok` |\n| A \\| B | done |');
assert.match(table, /<table/);
assert.match(table, /<th[^>]*scope="col"/);
assert.match(table, /<strong[^>]*>Agent<\/strong>/);
assert.match(table, /A \| B/);
assert.match(table, /text-align:right/);
assert.match(table, /<p[^>]*>Intro<\/p>/);
assert.doesNotMatch(render('```\n| A | B |\n| --- | --- |\n```'), /<table/);
assert.doesNotMatch(render('| A | B |\n| --- |'), /<table/);
const links = render('[Pull request](https://example.com/review) and https://example.com/docs.');
assert.match(links, /href="https:\/\/example\.com\/review"/);
assert.match(links, /href="https:\/\/example\.com\/docs"/);
assert.match(render('[Article](https://example.com/wiki/Title_(test))'), /href="https:\/\/example\.com\/wiki\/Title_\(test\)"/);
assert.match(render('(https://example.com/path).'), /href="https:\/\/example\.com\/path"/);
assert.match(render('Uygulama hazır: **[http://localhost:1420/](http://localhost:1420/)**'), /<strong[^>]*><a[^>]*href="http:\/\/localhost:1420\/"/);
assert.match(render('*https://example.com/docs*'), /<em><a[^>]*href="https:\/\/example\.com\/docs"/);
assert.doesNotMatch(render('`https://example.com`'), /<a /);
for (const unsafe of ['javascript:alert(1)', 'file:///tmp/secret', 'https://user:pass@example.com']) {
  assert.equal(browserUrl(unsafe), null);
}
useBrowserStore.getState().open('https://example.com');
assert.equal(useBrowserStore.getState().url, 'https://example.com/');
useBrowserStore.getState().open('javascript:alert(1)');
assert.equal(useBrowserStore.getState().url, 'https://example.com/');
useBrowserStore.getState().close();

// 1. 4-backtick carousel blocks with <!-- slide --> separators
const carouselMd = [
  '````carousel',
  '![Dark Slide](C:/Users/merte/.gemini/antigravity-cli/brain/7fd73736/slide1.png)',
  '<!-- slide -->',
  '![Light Slide](C:/Users/merte/.gemini/antigravity-cli/brain/7fd73736/slide2.png)',
  '````',
].join('\n');
const carouselHtml = render(carouselMd);
assert.match(carouselHtml, /aria-roledescription="carousel"/);
assert.match(carouselHtml, /1 \/ 2/);
assert.match(carouselHtml, /Dark Slide/);
assert.doesNotMatch(carouselHtml, /<!--\s*slide\s*-->/);

// 2. file:/// links and mid-word underscore preservation (NEW_PRODUCT, snake_case)
assert.equal(
  normalizeFileUri('file:///D:/Mert/Mert/Projects/MCorp/NEW_PRODUCT/AtrisHub/src/data/content.ts'),
  'D:/Mert/Mert/Projects/MCorp/NEW_PRODUCT/AtrisHub/src/data/content.ts',
);
const fileLinkHtml = renderToStaticMarkup(
  <MarkdownContent
    content="Check `NEW_PRODUCT` and [content.ts](file:///D:/Mert/Mert/Projects/MCorp/NEW_PRODUCT/AtrisHub/src/data/content.ts) with snake_case_var."
    onLocalFileLink={() => {}}
  />,
);
assert.match(fileLinkHtml, /title="D:\/Mert\/Mert\/Projects\/MCorp\/NEW_PRODUCT\/AtrisHub\/src\/data\/content\.ts"/);
assert.match(fileLinkHtml, />content\.ts<\/span><\/button>/);
assert.match(fileLinkHtml, /snake_case_var/);
assert.doesNotMatch(fileLinkHtml, /<em>PRODUCT/);
assert.doesNotMatch(fileLinkHtml, /<em>case<\/em>/);

// 3. GitHub-style alerts
const alertHtml = render('> [!TIP]\n> Zero overflow verified with `overflow-x: clip`.');
assert.match(alertHtml, /role="note"/);
assert.match(alertHtml, /aria-label="Tip"/);
assert.match(alertHtml, /overflow-x: clip/);
assert.doesNotMatch(alertHtml, /\[!TIP\]/);

// 4. Ordered list with indented nested bullets keeps sequential numbering in a single <ol>
const nestedListMd = [
  '1. **First item:**',
  '   - Sub bullet A',
  '   - Sub bullet B',
  '2. **Second item:**',
  '   - Sub bullet C',
  '3. **Third item**',
].join('\n');
const nestedListHtml = render(nestedListMd);
assert.equal((nestedListHtml.match(/<ol\b/g) || []).length, 1, 'Ordered list with nested bullets stays in a single <ol>');
assert.equal((nestedListHtml.match(/<ul\b/g) || []).length, 2, 'Indented sub-bullets render as nested <ul> lists');
assert.match(nestedListHtml, /Sub bullet A/);
assert.match(nestedListHtml, /Second item:/);

// 5. Image path normalization, magic-byte MIME detection, and automatic gateway fallback
assert.equal(
  normalizeImagePath('file:///C:/Users/merte/.gemini/antigravity/brain/abc/My%20Diagram.png?v=1#top'),
  'C:/Users/merte/.gemini/antigravity/brain/abc/My Diagram.png',
);
assert.equal(
  normalizeImagePath('file:///Users/mert/proj#1/shot.png#L2'),
  '/Users/mert/proj#1/shot.png',
);
assert.equal(
  normalizeImagePath('`C:\\\\Users\\\\mert\\\\shot.png?cache=1`'),
  'C:\\Users\\mert\\shot.png',
);
assert.equal(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
assert.equal(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
assert.equal(detectImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif');
assert.equal(detectImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'image/webp');

{
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42]);
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as any).window;
  const fetchCalls: Array<{ url: string; body: string }> = [];
  configureApiRuntime({ origin: 'http://127.0.0.1:4321', runtimeToken: 'test-token' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), body: String(init?.body || '') });
    return new Response(
      JSON.stringify({ mimeType: 'image/png', dataBase64: Buffer.from(pngBytes).toString('base64') }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    // Non-Tauri runtime uses gateway directly
    delete (globalThis as any).window;
    const webBlob = await loadLocalImagePreviewBlob({
      cwd: '',
      path: 'file:///C:/Users/merte/.gemini/antigravity/brain/abc/shot.png?v=1',
    });
    assert.equal(webBlob.type, 'image/png');
    assert.deepEqual(new Uint8Array(await webBlob.arrayBuffer()), pngBytes);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'http://127.0.0.1:4321/api/manual/image-preview');
    assert.deepEqual(JSON.parse(fetchCalls[0].body), {
      cwd: '',
      path: 'C:/Users/merte/.gemini/antigravity/brain/abc/shot.png',
    });

    // Tauri runtime tries native invoke first and falls back to gateway on rejection
    const invokeCalls: Array<{ cmd: string; args: unknown }> = [];
    (globalThis as any).window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string, args: unknown) => {
          invokeCalls.push({ cmd, args });
          throw new Error('Image is outside this project');
        },
      },
    };
    const fallbackBlob = await loadLocalImagePreviewBlob({
      cwd: 'D:/Mert/Project',
      path: 'C:/Users/merte/.gemini/antigravity/brain/abc/shot.png',
    });
    assert.equal(invokeCalls.length, 1);
    assert.equal(invokeCalls[0].cmd, 'manual_project_image_preview');
    assert.equal(fetchCalls.length, 2);
    assert.deepEqual(new Uint8Array(await fallbackBlob.arrayBuffer()), pngBytes);

    // Tauri runtime uses native bytes directly when invoke succeeds
    (globalThis as any).window = {
      __TAURI_INTERNALS__: {
        invoke: async () => Array.from(pngBytes),
      },
    };
    const nativeBlob = await loadLocalImagePreviewBlob({
      cwd: 'D:/Mert/Project',
      path: 'assets/screen.png',
    });
    assert.equal(nativeBlob.type, 'image/png');
    assert.equal(fetchCalls.length, 2, 'Gateway fallback is not called when native invoke succeeds');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
  }
}

console.log('Markdown table, carousel, file link, alert, nested list, and image preview loader tests passed');
