import assert from 'node:assert/strict';
import { addOrchestratorFiles, attachmentMimeType, canPreviewAttachment, useOrchestratorAttachmentsStore } from './orchestrator-attachments-store';
import { configureApiRuntime } from '@/lib/api-client';
import { setAuthToken } from '@/lib/token-provider';

const file = (name: string, text = 'reference', type = '') => new File([text], name, { type, lastModified: 1 });
const first = file('first.txt');
assert.deepEqual(addOrchestratorFiles([], [first, file('first.txt')]), [first], 'duplicates use Manual name/size/mtime identity');
assert.throws(() => addOrchestratorFiles([first], [file('empty.txt', '')]), /empty/);
assert.throws(() => addOrchestratorFiles([], Array.from({ length: 11 }, (_, index) => file(`${index}.txt`))), /up to 10/);
const large = new File([new Uint8Array(10 * 1024 * 1024)], 'large.bin');
assert.throws(() => addOrchestratorFiles([], [new File([new Uint8Array(large.size + 1)], 'huge.bin')]), /per-file/);
assert.throws(() => addOrchestratorFiles([large, new File([new Uint8Array(large.size)], 'second.bin')], [new File([new Uint8Array(6 * 1024 * 1024)], 'third.bin')]), /total limit/);
assert.equal(attachmentMimeType(file('screen.PNG')), 'image/png', 'empty browser MIME uses supported extension');
assert.equal(attachmentMimeType(file('notes.md')), 'text/markdown');
assert.equal(canPreviewAttachment(file('screen.png')), true);
assert.equal(canPreviewAttachment(file('vector.svg')), false);
assert.throws(() => addOrchestratorFiles([], [file('vector.svg', '<svg/>')]), /SVG/);
assert.throws(() => addOrchestratorFiles([], [file('video.mp4', 'x', 'video/mp4')]), /unsupported/);

const originalFetch = globalThis.fetch;
configureApiRuntime({ origin: 'http://127.0.0.1:4311', runtimeToken: 'test-runtime' });
setAuthToken('test-user');
const store = useOrchestratorAttachmentsStore.getState;
const calls: Array<Record<string, any>> = [];
let failSecond = true;
globalThis.fetch = async (_input, init) => {
  assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-user');
  assert.equal(new Headers(init?.headers).get('X-Atris-Runtime-Token'), 'test-runtime');
  const body = JSON.parse(String(init?.body));
  calls.push(body);
  if (body.name === 'second.json' && failSecond) return new Response(JSON.stringify({ error: 'Upload unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ id: `${body.workspaceId}-${body.name}`, workspaceId: body.workspaceId,
    name: body.name, mimeType: body.mimeType, byteSize: atob(body.dataBase64).length, sha256: 'hash', createdAt: 'now', providerPath: 'must-not-retain' }), { status: 201, headers: { 'content-type': 'application/json' } });
};
try {
  const scope = 'conversation:one';
  const second = file('second.json', '{"valid":true}');
  store().addFiles(scope, [first, second]);
  store().addFiles('draft:other', [file('other.txt')]);
  await assert.rejects(() => store().upload(scope, 'workspace-one'), /Upload unavailable/);
  assert.deepEqual(store().scopes[scope]?.files, [first, second], 'partial failure preserves the full draft');
  assert.equal(store().scopes[scope]?.uploading, false);
  assert.equal(store().scopes[scope]?.error, 'Upload unavailable');
  assert.equal(store().scopes['draft:other']?.files.length, 1, 'other conversation scope is untouched');
  failSecond = false;
  const uploaded = await store().upload(scope, 'workspace-one');
  assert.equal(calls.filter((body) => body.name === 'first.txt').length, 1, 'retry reuses the successful staged ID');
  assert.deepEqual(uploaded.attachmentIds, ['workspace-one-first.txt', 'workspace-one-second.json']);
  assert(!('providerPath' in uploaded.attachments[0]), 'only UI-safe refs retained');
  assert.equal(calls[0]?.dataBase64, btoa('reference'), 'outgoing transport is canonical base64');
  assert.equal(calls[2]?.mimeType, 'application/json');
  assert.equal(store().scopes[scope]?.files.length, 2, 'successful upload waits for explicit accepted-submit clear');
  await store().upload(scope, 'workspace-one');
  assert.equal(calls.length, 3, 'mission submission retries do not re-upload any staged file');
  await store().upload(scope, 'workspace-two');
  assert.equal(calls.length, 5, 'staged IDs cannot leak across workspace boundaries');
  store().removeFile(scope, 0);
  assert.deepEqual(store().scopes[scope]?.files, [second]);
  store().addFiles(scope, [file('empty.txt', '')]);
  assert.deepEqual(store().scopes[scope]?.files, [second], 'invalid additions preserve the previous draft');
  store().clearFiles(scope);
  assert.equal(store().scopes[scope], undefined);
  assert.equal(store().scopes['draft:other']?.files.length, 1);
  await assert.rejects(() => store().upload('draft:other', null), /Select a workspace/);
  assert.equal(store().scopes['draft:other']?.files.length, 1);

  let release!: (response: Response) => void;
  globalThis.fetch = () => new Promise((resolve) => { release = resolve; });
  const busyFile = file('busy.txt');
  store().addFiles('conversation:busy', [busyFile]);
  const busyUpload = store().upload('conversation:busy', 'workspace-one');
  assert.equal(store().scopes['conversation:busy']?.uploading, true);
  assert.equal(store().upload('conversation:busy', 'workspace-one'), busyUpload, 'overlapping sends share one upload');
  // Let File.arrayBuffer reach the mocked network, then create a fresh draft under the same scope.
  await new Promise((resolve) => setTimeout(resolve, 0));
  store().clearFiles('conversation:busy');
  store().addFiles('conversation:busy', [file('fresh.txt')]);
  release(new Response(JSON.stringify({ error: 'Old upload failed' }), { status: 503, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(() => busyUpload, /Old upload failed/);
  assert.equal(store().scopes['conversation:busy']?.error, null, 'old completion cannot mutate a freshly cleared/recreated scope');
  assert.equal(store().scopes['conversation:busy']?.files[0]?.name, 'fresh.txt');

  const png = new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], 'pasted', { lastModified: 2 });
  store().addFiles('draft:sniff', [png]);
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.mimeType, 'image/png', 'empty-MIME clipboard bytes are sniffed without an extension');
    return new Response(JSON.stringify({ id: 'sniffed', ...body, byteSize: 8, sha256: 'hash', createdAt: 'now' }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  await store().upload('draft:sniff', 'workspace-one');
} finally {
  globalThis.fetch = originalFetch;
  setAuthToken(null);
}
console.log('Orchestrator attachment transport/retry/scope tests passed.');
