import assert from 'node:assert/strict';
import type { ManualConversation } from './manual-store';
import type { AgentActivity } from '@/components/manual/manual-activity';
import type { ManualAgent } from './manual-store';
import { automaticLayout, layoutIds, moveInLayout, resizeLayout, reconcileLayout, minimumLayout, layoutRects, dropPlacement } from '@/components/manual/terminal-layout';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const persisted = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => persisted.get(key) ?? null,
  setItem: (key: string, value: string) => { persisted.set(key, value); },
  removeItem: (key: string) => { persisted.delete(key); },
} });
// Zustand's browser persistence reads window.localStorage at store creation.
Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: globalThis.localStorage } });
const { useManualStore, migrateManualNavigation } = await import('./manual-store');
if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
else Reflect.deleteProperty(globalThis, 'window');
const { useMissionStore } = await import('./mission-store');
const { activityNotice, conversationActivity } = await import('@/components/manual/manual-activity');
const { addManualFiles } = await import('@/components/manual/manual-composer');

const conversation: ManualConversation = { id: 'manual-a', workspaceId: 'project-a', title: 'Manual work', createdAt: '2026-09-08', agents: [] };
const store = useManualStore;
assert.equal(migrateManualNavigation({mode:'orchestrator'}).mode,'choose', 'Existing installations discover the new workspace home');
assert.deepEqual(migrateManualNavigation({activeByWorkspace:{project:'conversation'}}).activeByWorkspace,{project:'conversation'},'Navigation migration preserves saved conversation selection');
store.setState({ conversations: {'project-a': [conversation]}, activeByWorkspace: {}, agentByConversation: {}, surfaceByConversation: {}, drafts: {} });
store.getState().select(conversation);
store.getState().selectAgent('manual-a', 'agent-a');
store.getState().setDraft('agent-a', 'Keep this draft');
store.getState().setDraft('agent-b', 'Separate draft');
store.getState().setSurface('manual-a', 'code');
store.getState().setLayout('manual-a', 4);
store.getState().setLayout('manual-b', 2);
assert.equal(store.getState().layoutByConversation['manual-a'], 4, 'Terminal layouts are scoped to each conversation');
store.getState().setLayout('manual-b', 3);
assert.equal(store.getState().layoutByConversation['manual-b'], 1, 'Unsupported layouts fall back to focus');
store.getState().setMode('orchestrator');
store.getState().select(conversation);
assert.equal(store.getState().surfaceByConversation['manual-a'], 'code');
assert.equal(store.getState().agentByConversation['manual-a'], 'agent-a');
assert.equal(store.getState().drafts['agent-a'], 'Keep this draft');
assert.equal(store.getState().drafts['agent-b'], 'Separate draft');
const fetchMissionState = useMissionStore.getState().fetchMissionState;
useMissionStore.setState({ fetchMissionState: async () => undefined });
useMissionStore.getState().setActiveMission('mission-a', false);
assert.equal(store.getState().mode, 'manual', 'Background mission hydration preserves manual navigation');
useMissionStore.getState().setActiveMission('mission-a');
assert.equal(store.getState().mode, 'orchestrator', 'Explicit mission selection opens the orchestrator even for the same mission');
useMissionStore.setState({ fetchMissionState });

const oldFetch = globalThis.fetch;
let release: (response: Response) => void = () => undefined;
globalThis.fetch = (() => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch;
const stale = store.getState().refresh('project-a');
globalThis.fetch = (async () => new Response(JSON.stringify({...conversation, id: 'manual-b'}), {status: 200, headers: {'Content-Type': 'application/json'}})) as typeof fetch;
await store.getState().create('project-a', 'New work', 'manual-b');
release(new Response('[]', {status: 200, headers: {'Content-Type': 'application/json'}}));
await stale;
assert.ok(store.getState().conversations['project-a'].some(c => c.id === 'manual-b'), 'Stale hydration cannot erase a newly created conversation');
globalThis.fetch = oldFetch;
const agents = ['a','b','c'].map(id => ({id,conversationId:'manual-a'} as ManualAgent));
store.setState({conversations:{'project-a':[{...conversation,agents}]}});
const attachment = new File(['image'], 'draft.png', { type: 'image/png' });
const added = new File(['notes'], 'notes.txt');
const updateAttachments = store.getState().updateAttachments;
updateAttachments('a', current => addManualFiles(current, [attachment]));
updateAttachments('a', current => addManualFiles(current, [added]));
updateAttachments('b', () => [added]);
assert.deepEqual(store.getState().attachments.a, [attachment, added], 'Sequential callbacks use the latest external draft rather than a render snapshot');
store.getState().selectAgent('manual-a','b');
store.getState().setSurface('manual-a','chat');
assert.deepEqual(store.getState().attachments.b,[added], 'Agents in the same conversation keep independent attachment drafts');
assert.deepEqual(store.getState().attachments.a,[attachment,added], 'Switching agents and surfaces preserves the original File objects');
store.getState().setSurface('manual-a','code');
const beforeInvalidBatch = store.getState().attachments;
assert.throws(() => updateAttachments('a', current => addManualFiles(current, [new File(['valid'], 'valid.txt'), new File([], 'empty.txt')])), /empty/);
assert.equal(store.getState().attachments, beforeInvalidBatch, 'Invalid batches leave all attachments untouched');
const navigation = JSON.parse(persisted.get('atris-manual-navigation')!);
assert.equal('attachments' in navigation.state, false, 'File objects are excluded from serialized navigation');
assert.equal('drafts' in navigation.state, false, 'Text and file drafts both remain session-local');
await store.persist.rehydrate();
assert.equal(store.getState().attachments.a[0], attachment, 'Navigation hydration preserves the in-memory File identity');
const naming = {conversationId:'manual-a',agentId:'b',agentName:'Review checkout',conversationTitle:'Checkout improvements'};
store.getState().applyNaming(naming);
assert.equal(store.getState().conversations['project-a'][0].title,'Checkout improvements');
assert.equal(store.getState().conversations['project-a'][0].agents[1].name,'Review checkout','One shared name drives Chat tabs and Code panes');
assert.equal(store.getState().surfaceByConversation['manual-a'],'code','Automatic naming does not switch surfaces');
const beforeRepeatedNaming = store.getState().conversations;
store.getState().applyNaming(naming);
assert.equal(store.getState().conversations,beforeRepeatedNaming,'Repeated activity polls do not re-render unchanged titles');
store.getState().applyNaming({conversationId:'manual-a',agentId:'deleted',agentName:'Late response',conversationTitle:'Wrong title'});
assert.equal(store.getState().conversations,beforeRepeatedNaming,'Late deleted-agent results do not rename or recreate anything');
globalThis.fetch = (() => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch;
const staleNames = store.getState().refresh('project-a');
store.getState().applyNaming({...naming,agentId:'c',agentName:'Independent terminal'});
release(new Response(JSON.stringify([{...conversation,agents}]),{status:200,headers:{'Content-Type':'application/json'}}));
await staleNames;
assert.equal(store.getState().conversations['project-a'][0].agents[2].name,'Independent terminal','A stale list fetch cannot overwrite a new title');
globalThis.fetch = oldFetch;
store.getState().moveAgent('manual-a','a','c');
assert.deepEqual(store.getState().orderByConversation['manual-a'],['b','c','a']);
store.getState().moveAgent('manual-a','a','b');
assert.deepEqual(store.getState().orderByConversation['manual-a'],['a','b','c']);
store.getState().hideAgent('a',true);
store.getState().acknowledgeActivity('a','completed:2026-09-09T10:08:00Z');
store.getState().setTerminalLayout('manual-a',automaticLayout(['a','b','c'],2));
assert.equal(store.getState().conversations['project-a'][0].agents.length,3,'Temporary hiding during restart does not delete an agent');
store.getState().selectAgent('manual-a','a');store.getState().setDraft('a','Discard on explicit close');
globalThis.fetch = (async () => new Response(null,{status:204})) as typeof fetch;
await store.getState().removeAgent(agents[0]);
assert.deepEqual(store.getState().conversations['project-a'][0].agents.map(agent=>agent.id),['b','c']);
assert.equal(store.getState().agentByConversation['manual-a'],'b');
assert.equal(store.getState().drafts.a,undefined);
assert.equal(store.getState().attachments.a,undefined, 'Explicit agent deletion releases its File references');
assert.deepEqual(store.getState().attachments.b,[added], 'Deleting one agent preserves sibling attachment drafts');
store.getState().clearSentDraft('a', 'Discard on explicit close', [attachment, added]);
updateAttachments('a', () => [attachment]);
assert.equal(store.getState().attachments.a,undefined, 'Late completion or file-picker callbacks cannot recreate a deleted agent draft');
assert.equal(store.getState().drafts.a,undefined, 'Late success cannot recreate deleted text');
assert.equal(store.getState().hiddenAgents.a,undefined);
assert.equal(store.getState().acknowledgedActivity.a,undefined);
assert.equal(store.getState().terminalLayouts['manual-a'],undefined,'Removal invalidates panes containing the deleted agent');
assert.deepEqual(store.getState().orderByConversation['manual-a'],['b','c']);
store.getState().selectAgent('manual-a','b');
await store.getState().removeAgent(agents[1]);
assert.equal(store.getState().agentByConversation['manual-a'],'c','Deleting the selected agent selects the next visible tab');
await store.getState().removeAgent(agents[2]);
assert.equal(store.getState().agentByConversation['manual-a'],'','Deleting the last agent leaves an empty selection');
globalThis.fetch = oldFetch;
const now = Date.parse('2026-09-09T10:10:00Z');
const observed = (state: string, lifecycle: AgentActivity['lifecycle'] = 'open'): AgentActivity => ({state,lifecycle,checkedAt:now,at:'2026-09-09T10:08:00Z'});
assert.equal(conversationActivity([],{},now).kind,'empty');
assert.equal(conversationActivity(agents,{},now).kind,'unknown');
assert.equal(conversationActivity(agents,{a:observed('unknown','closed'),b:observed('unknown','closed'),c:observed('unknown','exited')},now).kind,'closed');
assert.equal(conversationActivity(agents,{a:observed('completed'),b:observed('completed'),c:observed('unknown')},now).kind,'open','Unknown activity never counts as finished');
assert.equal(conversationActivity(agents,{a:observed('completed'),b:observed('completed'),c:observed('completed')},now).text,'Turns finished 2m ago');
assert.equal(conversationActivity(agents,{a:observed('completed'),b:observed('working'),c:observed('completed')},now).kind,'working');
assert.equal(conversationActivity(agents,{a:observed('completed'),b:observed('attention'),c:observed('working')},now).kind,'attention');
assert.equal(activityNotice(observed('attention'),undefined,now),'attention');
assert.equal(activityNotice(observed('completed'),'completed:2026-09-09T10:08:00Z',now),null,'Viewed turns are acknowledged');
assert.equal(activityNotice(observed('attention'),'completed:2026-09-09T10:08:00Z',now),'attention','A new question survives an earlier completion acknowledgement');
assert.equal(activityNotice(observed('completed','exited'),undefined,now),null,'Closed CLI cannot advertise a stale turn');
assert.equal(activityNotice({...observed('attention'),checkedAt:now-16000},undefined,now),null,'Disconnected observations do not produce unread badges');
console.log('Manual navigation, independent drafts and stale hydration regression tests passed.');
const initial = automaticLayout(['a','b','c','d'],2)!;
assert.equal(initial.type,'split');
if(initial.type === 'split') {
  const resized = resizeLayout(initial,initial.id,.65);
  const moved = moveInLayout(resized,'d','a','left');
  assert.deepEqual(new Set(layoutIds(moved)),new Set(['a','b','c','d']));
  assert.deepEqual(layoutIds(moveInLayout(initial,'a','d','swap')),['d','b','c','a']);
  const pruned = reconcileLayout(resized,['a','b','c']);
  assert.equal(pruned?.type === 'split' && pruned.ratio,.65,'Closing a leaf preserves surviving ratios');
  const added = reconcileLayout(resized,['a','b','c','d','e']);
  assert.ok(JSON.stringify(added).includes(initial.id),'New agents preserve the existing geometry');
  const minimum = minimumLayout(moved), geometry=layoutRects(moved,minimum.width,minimum.height);
  assert.equal(Object.keys(geometry.panes).length,4);
  for(const rect of Object.values(geometry.panes)){assert.ok(rect.width>=320);assert.ok(rect.height>=240);}
  assert.equal(dropPlacement(5,150,500,300),'left');
  assert.equal(dropPlacement(250,150,500,300),'swap');
}

const otherAgent = {id:'other',conversationId:'manual-other'} as ManualAgent;
const otherConversation = {...conversation,id:'manual-other',workspaceId:'project-other',agents:[otherAgent]};
const deleting = {...conversation,agents:[agents[0]]};
store.setState({conversations:{'project-a':[deleting],'project-other':[otherConversation]},attachments:{}});
store.getState().setDraft('a', 'Delete this text');
store.getState().setDraft('other', 'Keep this text');
updateAttachments('a', () => [attachment]);
updateAttachments('other', () => [added]);
globalThis.fetch = (() => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch;
try {
  const removal = store.getState().remove(deleting);
  store.setState(state => ({conversations:{...state.conversations,'project-a':[{...deleting,agents:[agents[0],agents[1]]}]}}));
  updateAttachments('b', () => [attachment]);
  store.getState().setDraft('b', 'Added during deletion');
  release(new Response(null,{status:204}));
  await removal;
  assert.deepEqual(store.getState().attachments,{other:[added]}, 'Conversation deletion cleans both captured and newly added agents, preserving other workspaces');
  assert.equal(store.getState().drafts.a, undefined);
  assert.equal(store.getState().drafts.b, undefined);
  assert.equal(store.getState().drafts.other, 'Keep this text');
  store.getState().clearSentDraft('a', 'Delete this text', [attachment]);
  assert.deepEqual(store.getState().attachments,{other:[added]}, 'Late conversation send completion cannot restore deleted files');
  // Cleanup still works if another refresh already removed the conversation from the list.
  store.setState({attachments:{...store.getState().attachments,a:[attachment]},drafts:{...store.getState().drafts,a:'orphan'}});
  globalThis.fetch = (async () => new Response(null,{status:204})) as typeof fetch;
  await store.getState().removeAgent(agents[0]);
  assert.equal(store.getState().attachments.a, undefined);
  assert.equal(store.getState().drafts.a, undefined);

  const removedConversation = {...conversation,id:'removed-conversation',agents:[{...agents[2],conversationId:'removed-conversation'}]};
  const beforeRefresh = {...conversation,agents:[agents[0],agents[1]]};
  store.setState({
    conversations:{'project-a':[beforeRefresh,removedConversation],'project-other':[otherConversation]},
    drafts:{a:'Keep sibling',b:'Removed agent',c:'Removed conversation',other:'Other project',unloaded:'Not yet loaded'},
    attachments:{a:[attachment],b:[added],c:[attachment],other:[added],unloaded:[attachment]},
  });
  const beforeFailure = store.getState();
  globalThis.fetch = (async () => new Response(JSON.stringify({error:'Unavailable'}),{status:503,headers:{'content-type':'application/json'}})) as typeof fetch;
  await store.getState().refresh('project-a');
  assert.equal(store.getState().conversations,beforeFailure.conversations,'Failed refresh retains the previously known agents');
  assert.equal(store.getState().drafts,beforeFailure.drafts,'Failed refresh cannot discard text drafts');
  assert.equal(store.getState().attachments,beforeFailure.attachments,'Failed refresh cannot discard Files');
  await assert.rejects(() => store.getState().remove(beforeRefresh),/Unavailable/);
  assert.equal(store.getState().drafts,beforeFailure.drafts,'Failed conversation deletion retains text drafts');
  assert.equal(store.getState().attachments,beforeFailure.attachments,'Failed conversation deletion retains Files');

  globalThis.fetch = (async () => new Response(JSON.stringify([{...beforeRefresh,agents:[agents[0]]}]),{status:200,headers:{'content-type':'application/json'}})) as typeof fetch;
  await store.getState().refresh('project-a');
  assert.deepEqual(store.getState().drafts,{a:'Keep sibling',other:'Other project',unloaded:'Not yet loaded'},'Authoritative refresh prunes only previously known IDs removed from this project');
  assert.deepEqual(store.getState().attachments,{a:[attachment],other:[added],unloaded:[attachment]},'Removed agents and conversations release Files without touching siblings or unloaded projects');
  assert.equal(store.getState().attachments.a[0],attachment,'Surviving File identity is preserved');

  globalThis.fetch = (async () => new Response('[]',{status:200,headers:{'content-type':'application/json'}})) as typeof fetch;
  await store.getState().refresh('not-yet-loaded-project');
  assert.deepEqual(store.getState().drafts,{a:'Keep sibling',other:'Other project',unloaded:'Not yet loaded'},'Loading an empty project does not infer ownership of unrelated drafts');
  assert.deepEqual(store.getState().attachments,{a:[attachment],other:[added],unloaded:[attachment]});

  let releaseOldRefresh!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>(resolve => { releaseOldRefresh = resolve; })) as typeof fetch;
  const oldRefresh = store.getState().refresh('project-a');
  globalThis.fetch = (async () => new Response(JSON.stringify([{...beforeRefresh,agents:[agents[0]]}]),{status:200,headers:{'content-type':'application/json'}})) as typeof fetch;
  await store.getState().refresh('project-a');
  releaseOldRefresh(new Response('[]',{status:200,headers:{'content-type':'application/json'}}));
  await oldRefresh;
  assert.equal(store.getState().drafts.a,'Keep sibling','Superseded refresh cannot prune a surviving draft');
  assert.equal(store.getState().attachments.a[0],attachment,'Superseded refresh cannot prune surviving Files');
} finally {
  globalThis.fetch = oldFetch;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
}
console.log('Manual attachment lifetime, atomic validation, persistence exclusion and deletion regressions passed.');
console.log('Manual authoritative refresh draft pruning and failure isolation regressions passed.');
