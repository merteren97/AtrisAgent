import assert from 'node:assert/strict';
import { addManualFiles, MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS } from './manual-composer';
import { assistantProjectImages, displayManualPrompt } from './manual-chat-content';
import { sendManualDraft } from './manual-attachment-send';
import { useManualStore, type ManualAgent, type ManualConversation } from '@/stores/manual-store';

const file = (name: string, size: number) => new File([new Uint8Array(size)], name, { lastModified: 1 });
const first = file('screenshot.png', 4);
const second = file('notes.txt', 2);

assert.deepEqual(addManualFiles([], [first, second]), [first, second], 'accepts images and documents together');
assert.deepEqual(addManualFiles([first], [first, second]), [first, second], 'ignores duplicate selections');
assert.throws(() => addManualFiles([], [file('empty.png', 0)]), /empty/);
assert.throws(() => addManualFiles([], [file('large.png', MAX_ATTACHMENT_SIZE + 1)]), /10 MB/);
assert.throws(() => addManualFiles(Array.from({ length: MAX_ATTACHMENTS }, (_, index) => file(`file-${index}.txt`, 1)), [second]), /Attach up to/);
assert.throws(() => addManualFiles([file('large.png', MAX_ATTACHMENT_SIZE)], [file('another.png', MAX_ATTACHMENT_SIZE), file('third.png', MAX_ATTACHMENT_SIZE)]), /25 MB/);
const sent = 'Inspect this\n\nAttached files (read these local paths to inspect their contents, including images):\n- "screen.png": "C:\\\\Temp\\\\abc.png"';
assert.deepEqual(displayManualPrompt(sent), {text:'Inspect this', attachments:[{name:'screen.png',path:'C:\\Temp\\abc.png'}]});
assert.deepEqual(displayManualPrompt('Inspect this\n\nAttached files (read these local paths to inspect their contents, including images):\n- invalid'), {text:'Inspect this\n\nAttached files (read these local paths to inspect their contents, including images):\n- invalid', attachments:[]});
const generated = 'Screens: [Light](AtrisAgent/landing-app-parity-light.png) · ![Dark](AtrisAgent/landing-app-parity-dark.PNG) · [Hub](AtrisHub/atrisagent-hub-light.png)';
assert.deepEqual(assistantProjectImages(generated), [
  {name:'Light',path:'AtrisAgent/landing-app-parity-light.png'},
  {name:'Dark',path:'AtrisAgent/landing-app-parity-dark.PNG'},
  {name:'Hub',path:'AtrisHub/atrisagent-hub-light.png'},
]);
assert.deepEqual(assistantProjectImages('[External](https://example.test/screen.png) [Data](data:image/png) [Local](C:\\Projects\\shot.webp) [Again](C:\\Projects\\shot.webp)'), [{name:'Local',path:'C:\\Projects\\shot.webp'}]);

const store = useManualStore;
const agent = {id:'attachment-agent',conversationId:'attachment-conversation'} as ManualAgent;
const other = {id:'other-agent',conversationId:'other-conversation'} as ManualAgent;
const conversation: ManualConversation = {id:agent.conversationId,workspaceId:'workspace-one',title:'Attachments',createdAt:'now',agents:[agent]};
const otherConversation = {...conversation,id:other.conversationId,workspaceId:'workspace-two',agents:[other]};
const resetDraft = () => store.setState({conversations:{'workspace-one':[conversation],'workspace-two':[otherConversation]},drafts:{[agent.id]:' Inspect this ',[other.id]:'Other draft'},attachments:{[agent.id]:[first],[other.id]:[second]}});
const add = (incoming: File[]) => store.getState().updateAttachments(agent.id, current => addManualFiles(current, incoming));
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(null,{status:204});
try {
  resetDraft();
  let releaseStage!: (path: string) => void;
  let written: {id: string; prompt: string} | undefined;
  const sending = sendManualDraft(agent, {
    stage: (id, selected) => {
      assert.equal(id,agent.id);
      assert.equal(selected,first);
      return new Promise(resolve => { releaseStage = resolve; });
    },
    write: async (id, prompt) => { written = {id,prompt}; },
  });
  // Delivery needs no mounted workspace subscriber. Navigate and edit while staging.
  store.getState().select(otherConversation);
  const replacement = file(first.name, first.size); // Same metadata, different File identity.
  store.getState().updateAttachments(agent.id, () => [replacement]);
  add([second]);
  store.getState().setDraft(agent.id,'New text while sending');
  assert.equal(sendManualDraft(agent,{
    stage:async () => { throw new Error('Duplicate staging after remount'); },
    write:async () => { throw new Error('Duplicate write after remount'); },
  }),sending,'A second workspace instance shares the existing delivery instead of submitting twice');
  const independentDelivery = sendManualDraft(other,{
    stage:async () => '/other.txt',
    write:async id => { assert.equal(id,other.id); },
  });
  await independentDelivery;
  // Start a new draft in that workspace; the first agent must not consume it.
  store.getState().setDraft(other.id,'Other draft');
  store.getState().updateAttachments(other.id, () => [second]);
  releaseStage('C:\\Temp\\staged.png');
  await sending;
  assert.equal(written?.id,agent.id,'Navigation does not redirect the in-flight delivery');
  assert.deepEqual(displayManualPrompt(written!.prompt),{text:'Inspect this',attachments:[{name:first.name,path:'C:\\Temp\\staged.png'}]});
  assert.deepEqual(store.getState().attachments[agent.id],[replacement,second],'Late success removes only sent File identities, preserving reselected and newly added files');
  assert.equal(store.getState().drafts[agent.id],'New text while sending');
  assert.deepEqual(store.getState().attachments[other.id],[second],'Sending never touches another workspace agent');
  assert.equal(store.getState().drafts[other.id],'Other draft');

  resetDraft();
  await sendManualDraft(agent,{stage:async () => '/staged.png',write:async () => {}});
  assert.equal(store.getState().attachments[agent.id],undefined,'Accepted send releases the final File array');
  assert.equal(store.getState().drafts[agent.id],'','Unchanged text clears only after acceptance');

  for (const failure of ['stage','write'] as const) {
    resetDraft();
    let writes = 0;
    await assert.rejects(() => sendManualDraft(agent,{
      stage:async () => { if (failure === 'stage') throw new Error('stage failed'); return '/staged.png'; },
      write:async () => { writes++; throw new Error('write failed'); },
    }),new RegExp(`${failure} failed`));
    assert.equal(writes,failure === 'stage' ? 0 : 1);
    assert.deepEqual(store.getState().attachments[agent.id],[first],`${failure} failure preserves files for retry`);
    assert.equal(store.getState().drafts[agent.id],' Inspect this ',`${failure} failure preserves text`);
    await sendManualDraft(agent,{stage:async () => '/retry.png',write:async () => {}});
    assert.equal(store.getState().attachments[agent.id],undefined,'A failed delivery releases its in-flight lock for retry');
  }

  resetDraft();
  let rejectWrite!: (error: Error) => void;
  let startFailure!: () => void;
  const failingWriteStarted = new Promise<void>(resolve => { startFailure = resolve; });
  const lateFailure = sendManualDraft(agent,{
    stage:async () => '/staged.png',
    write:() => { startFailure(); return new Promise((_resolve,reject) => { rejectWrite = reject; }); },
  });
  await failingWriteStarted;
  store.getState().select(otherConversation);
  add([second]);
  store.getState().setDraft(agent.id,'Edited before rejection');
  rejectWrite(new Error('late failure'));
  await assert.rejects(lateFailure,/late failure/);
  assert.deepEqual(store.getState().attachments[agent.id],[first,second],'Failure after navigation preserves both submitted and newly added files');
  assert.equal(store.getState().drafts[agent.id],'Edited before rejection');

  resetDraft();
  let writes = 0;
  const deletingDuringStage = sendManualDraft(agent,{
    stage:() => new Promise(resolve => { releaseStage = resolve; }),
    write:async () => { writes++; },
  });
  await store.getState().removeAgent(agent);
  releaseStage('/staged.png');
  await deletingDuringStage;
  assert.equal(writes,0,'Deleting an agent while staging prevents terminal delivery');
  assert.equal(store.getState().attachments[agent.id],undefined);

  resetDraft();
  let releaseWrite!: () => void;
  let startedWrite!: () => void;
  const writing = new Promise<void>(resolve => { startedWrite = resolve; });
  const deletingDuringWrite = sendManualDraft(agent,{
    stage:async () => '/staged.png',
    write:() => { startedWrite(); return new Promise(resolve => { releaseWrite = resolve; }); },
  });
  await writing;
  await store.getState().remove(conversation);
  releaseWrite();
  await deletingDuringWrite;
  assert.equal(store.getState().attachments[agent.id],undefined,'Completion after conversation deletion cannot resurrect files');
  assert.equal(store.getState().drafts[agent.id],undefined,'Completion after conversation deletion cannot resurrect text');
  assert.deepEqual(store.getState().attachments[other.id],[second]);
} finally {
  globalThis.fetch = oldFetch;
}

console.log('Manual composer attachment validation passed.');
console.log('Manual attachment send navigation, identity, failure and deletion regressions passed.');
