import assert from 'node:assert/strict';
import type { ManualAgent, ManualConversation } from './manual-store';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  configurable: true,
});
Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });

const { useWorkspaceStore } = await import('./workspace-store');
const { useManualStore } = await import('./manual-store');

useWorkspaceStore.setState({ lastMissionByWorkspace: {} });
useWorkspaceStore.getState().rememberMission('workspace-1', 'mission-1');
useWorkspaceStore.getState().rememberMission('workspace-2', 'mission-2');
useWorkspaceStore.getState().forgetMission('workspace-1', 'mission-1');

assert.equal(useWorkspaceStore.getState().lastMissionByWorkspace['workspace-1'], undefined, 'deleted conversation is forgotten by workspace navigation');
assert.equal(useWorkspaceStore.getState().lastMissionByWorkspace['workspace-2'], 'mission-2', 'other workspace navigation state is preserved');

useWorkspaceStore.getState().forgetMission('workspace-2', 'different-mission');
assert.equal(useWorkspaceStore.getState().lastMissionByWorkspace['workspace-2'], 'mission-2', 'unrelated conversation deletion does not clear the remembered selection');

const originalFetch = globalThis.fetch;
const localAgent = {id:'local-agent',conversationId:'local-conversation'} as ManualAgent;
const otherAgent = {id:'other-agent',conversationId:'other-conversation'} as ManualAgent;
const localConversation: ManualConversation = {id:localAgent.conversationId,workspaceId:'workspace-2',title:'Local',createdAt:'now',agents:[localAgent]};
const otherConversation: ManualConversation = {...localConversation,id:otherAgent.conversationId,workspaceId:'workspace-other',agents:[otherAgent]};
const attachment = new File(['draft'], 'draft.png', {type:'image/png'});
useManualStore.setState({
  conversations:{'workspace-2':[localConversation],'workspace-other':[otherConversation]},
  drafts:{[localAgent.id]:'Keep on failure',[otherAgent.id]:'Other workspace',unloaded:'Unloaded workspace'},
  attachments:{[localAgent.id]:[attachment],[otherAgent.id]:[attachment],unloaded:[attachment]},
  activeByWorkspace:{'workspace-2':localConversation.id,'workspace-other':otherConversation.id},
});
const beforeFailure = useManualStore.getState();
useWorkspaceStore.setState({ workspaces: [{ id: 'workspace-2', name: 'Project', path: 'C:/Project' }], activeWorkspaceId: 'workspace-2', error: null });
let deletionBody = '';
globalThis.fetch = async (_input, init) => {
  if (String(_input).includes('/manual/conversations')) return new Response('[]', {status:200,headers:{'content-type':'application/json'}});
  deletionBody = String(init?.body || '');
  return new Response(JSON.stringify({ error: 'Active conversations remain.' }), { status: 409, headers: { 'content-type': 'application/json' } });
};
await assert.rejects(() => useWorkspaceStore.getState().removeWorkspace('workspace-2', true), /Active conversations remain/, 'workspace deletion failures are visible to the confirmation dialog');
assert.deepEqual(JSON.parse(deletionBody), { removeMemory: true }, 'workspace and memory deletion use one authoritative backend operation');
assert.equal(useWorkspaceStore.getState().workspaces.length, 1, 'failed workspace deletion preserves local navigation state');
assert.equal(useManualStore.getState().conversations,beforeFailure.conversations,'Rejected workspace deletion preserves manual conversations');
assert.equal(useManualStore.getState().drafts,beforeFailure.drafts,'Rejected workspace deletion preserves text drafts');
assert.equal(useManualStore.getState().attachments,beforeFailure.attachments,'Rejected workspace deletion preserves File references');

let deleted = false;
globalThis.fetch = async (_input, init) => {
  if (init?.method === 'DELETE') deleted = true;
  return new Response(JSON.stringify([{agents:[{id:'manual-agent'}]}]), {status:200,headers:{'content-type':'application/json'}});
};
await assert.rejects(() => useWorkspaceStore.getState().removeWorkspace('workspace-2'), /desktop app/, 'A browser cannot discard ownership of native manual sessions');
assert.equal(deleted, false);
Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {value:{invoke:async()=>({status:'open'})},configurable:true});
await assert.rejects(() => useWorkspaceStore.getState().removeWorkspace('workspace-2'), /Close the project/, 'Live manual agents require explicit close before project removal');
assert.equal(deleted, false);
assert.equal(useManualStore.getState().attachments,beforeFailure.attachments,'Native-session preflight rejection preserves attachment drafts');
delete (globalThis as any).__TAURI_INTERNALS__;

try {
  const preflightAgent = {id:'preflight-agent',conversationId:'preflight-conversation'} as ManualAgent;
  const preflightConversation = {...localConversation,id:preflightAgent.conversationId,agents:[preflightAgent]};
  useManualStore.setState(state => ({drafts:{...state.drafts,[preflightAgent.id]:'Known to API'},attachments:{...state.attachments,[preflightAgent.id]:[attachment]}}));
  useWorkspaceStore.setState({workspaces:[{id:'workspace-2',name:'Remove',path:'C:/Remove'},{id:'workspace-other',name:'Keep',path:'C:/Keep'}],activeWorkspaceId:'workspace-other'});
  Object.defineProperty(globalThis,'__TAURI_INTERNALS__',{value:{invoke:async()=>({status:'closed'})},configurable:true});
  let releaseRefresh!: (response: Response) => void;
  let releaseDelete!: (response: Response) => void;
  let deleteStarted!: () => void;
  const deleting = new Promise<void>(resolve => { deleteStarted = resolve; });
  let reads = 0;
  globalThis.fetch = async (_input, init) => {
    if (String(_input).includes('/manual/conversations')) {
      if (++reads === 1) return new Promise<Response>(resolve => { releaseRefresh = resolve; });
      return new Response(JSON.stringify([preflightConversation]),{status:200,headers:{'content-type':'application/json'}});
    }
    assert.equal(init?.method,'DELETE');
    deleteStarted();
    return new Promise<Response>(resolve => { releaseDelete = resolve; });
  };
  const refresh = useManualStore.getState().refresh('workspace-2');
  const removal = useWorkspaceStore.getState().removeWorkspace('workspace-2');
  await deleting;
  assert.equal(useManualStore.getState().conversations,beforeFailure.conversations,'Pending API deletion has not discarded manual conversations');
  assert.equal(useManualStore.getState().attachments[localAgent.id][0],attachment,'Pending API deletion retains Files');
  // A draft added locally while DELETE is pending must also be cleaned after acceptance.
  const lateAgent = {...localAgent,id:'late-agent'};
  useManualStore.setState(state => ({conversations:{...state.conversations,'workspace-2':[{...localConversation,agents:[localAgent,lateAgent]}]}}));
  useManualStore.getState().setDraft(lateAgent.id,'Added during deletion');
  useManualStore.getState().updateAttachments(lateAgent.id,() => [attachment]);
  releaseDelete(new Response(null,{status:204}));
  await removal;
  assert.equal(useManualStore.getState().conversations['workspace-2'],undefined,'Confirmed workspace removal drops cached manual conversations');
  assert.deepEqual(useManualStore.getState().drafts,{[otherAgent.id]:'Other workspace',unloaded:'Unloaded workspace'},'Cleanup includes local and API-known agents while preserving unrelated drafts');
  assert.deepEqual(useManualStore.getState().attachments,{[otherAgent.id]:[attachment],unloaded:[attachment]});
  assert.equal(useManualStore.getState().conversations['workspace-other'][0],otherConversation);
  assert.deepEqual(useManualStore.getState().activeByWorkspace,{'workspace-other':otherConversation.id});
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId,'workspace-other');
  releaseRefresh(new Response(JSON.stringify([localConversation]),{status:200,headers:{'content-type':'application/json'}}));
  await refresh;
  assert.equal(useManualStore.getState().conversations['workspace-2'],undefined,'An older refresh cannot resurrect a removed workspace');
  useManualStore.getState().clearSentDraft(localAgent.id,'Keep on failure',[attachment]);
  assert.equal(useManualStore.getState().drafts[localAgent.id],undefined,'Late send completion cannot resurrect removed workspace drafts');
} finally {
  delete (globalThis as any).__TAURI_INTERNALS__;
  globalThis.fetch = originalFetch;
}

console.log('workspace navigation cleanup tests passed');
console.log('workspace removal manual draft cleanup, confirmation and stale-refresh regressions passed');
