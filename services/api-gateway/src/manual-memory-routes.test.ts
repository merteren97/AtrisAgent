import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import express from 'express';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@atris-agent-code/database';
import { ProjectMemoryService } from '@atris-agent-code/orchestration-core';
import type { AtrisDatabase } from '@atris-agent-code/database';
import type { ProjectMemoryRoutesOptions } from './project-memory-routes';
import { ManualConversationStore, type ManualAgent } from './manual-conversations';
import { installManualMemoryRoutes, importantManualMemory } from './manual-memory-routes';
import type { AddressInfo } from 'node:net';

const sqlite=new Database(':memory:');
sqlite.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL,git_initialized INTEGER DEFAULT 0,last_opened_at TEXT,last_team_template_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE missions(id TEXT PRIMARY KEY,workspace_id TEXT,title TEXT,description TEXT,status TEXT,team_template_id TEXT,plan_id TEXT,execution_mode TEXT,created_at TEXT,updated_at TEXT,completed_at TEXT);
CREATE TABLE mission_events(id TEXT PRIMARY KEY,mission_id TEXT,task_id TEXT,agent_instance_id TEXT,type TEXT,payload TEXT,created_at TEXT);`);
schema.migrateDatabase(sqlite as any);
const db=drizzle(sqlite,{schema}) as unknown as AtrisDatabase;
const now=new Date().toISOString();
const workspace={id:'w1',name:'Manual project',path:process.cwd(),gitInitialized:false,createdAt:now,updatedAt:now};
await db.insert(schema.workspaces).values(workspace);
const memory=new ProjectMemoryService(db);
const store=new ManualConversationStore(sqlite);
store.create('w1','Conversation A','c1');store.create('w1','Conversation B','c2');
const agent={id:'a1',conversationId:'c1',name:'A',createdAt:now} as ManualAgent;
store.save(agent);store.save({...agent,id:'a2',conversationId:'c2'});
const app=express();app.use(express.json());
installManualMemoryRoutes(app,store,{memory,workspaceManager:{getWorkspace:async(id:string)=>id==='w1'?workspace:null}} as ProjectMemoryRoutesOptions);
const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/manual/conversations`;
const post=(conversation:string,body:unknown)=>fetch(`${base}/${conversation}/memory`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
try{
  const result=await post('c1',{title:'Decision',summary:'Keep independent sessions',agentId:'a1',sourceId:'message-1'});
  assert.equal(result.status,201);const node=await result.json();
  assert.equal(node.provenance[0].conversationId,'c1');assert.equal(node.provenance[0].manualAgentId,'a1');
  assert.equal((await post('c1',{title:'Wrong',summary:'Wrong agent',agentId:'a2'})).status,400);
  assert.equal((await post('missing',{title:'Missing',summary:'No conversation'})).status,404);
  assert.equal((await post('c1',{title:'Unsafe',summary:'Ref',type:'external_source',url:'javascript:alert(1)'})).status,400);
  const reference=await post('c1',{title:'Docs',summary:'API documentation',type:'external_source',url:'https://example.test/docs',agentId:'a1'});
  assert.equal(reference.status,201);
  const list=await(await fetch(`${base}/c1/memory`)).json();assert.equal(list.nodes.length,2);
  const other=await(await fetch(`${base}/c2/memory`)).json();assert.equal(other.nodes.length,0);
  assert.equal((await fetch(`${base}/c2/memory?agentId=a1`)).status,400);
  const reloaded=new ProjectMemoryService(db);const snapshot=await reloaded.getSnapshot(list.projectId);
  assert.ok(snapshot.nodes.some(item=>item.id===node.id&&item.provenance?.[0]?.conversationId==='c1'),'Scoped memory survives a new service instance');
  assert.equal(snapshot.nodes.filter(item=>item.provenance?.some(p=>p.conversationId==='c1')).length,2,'Reads do not duplicate notes');
  assert.equal(importantManualMemory('Merhaba! Please create a portfolio.'),undefined,'Routine chat is not memory');
  assert.equal(importantManualMemory('Remember this API key: example-test'),undefined,'Credentials are not automatically captured');
  store.readMessages=()=>({supported:true,bound:true,truncated:false,messages:[
    {id:'u-auto',role:'user',text:'Bundan sonra bütün ajanların bağlamını bağımsız tut.'},
    {id:'a-auto',role:'assistant',text:'Decision: All security checks are complete.'},
    {id:'hello',role:'user',text:'Merhaba!'},
  ]});
  const sync=()=>fetch(`${base}/c1/memory/sync`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agentId:'a1',text:'Remember fabricated browser content.'})});
  const responses=await Promise.all([sync(),sync()]);assert.ok(responses.every(response=>response.status===200));
  const auto=await(await fetch(`${base}/c1/memory`)).json();
  assert.equal(auto.nodes.length,3,'Only the verified user constraint is captured once across concurrent sync');
  const captured=auto.nodes.find((item:any)=>item.tags.includes('automatic'));
  assert.equal(captured.summary,'Bundan sonra bütün ajanların bağlamını bağımsız tut.');
  await memory.deleteMemoryNode(captured.id);
  await sync();
  assert.equal((await(await fetch(`${base}/c1/memory`)).json()).nodes.length,2,'Explicitly forgotten auto-memory stays deleted');
  assert.equal((await fetch(`${base}/c2/memory/sync`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agentId:'a1'})})).status,400,'Auto capture cannot cross conversations');
  console.log('Manual memory persistence, provenance, isolation and safe reference tests passed.');
}finally{server.close();sqlite.close();}
