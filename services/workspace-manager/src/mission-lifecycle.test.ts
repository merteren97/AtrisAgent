import assert from 'node:assert/strict';
import { LocalEventBus } from '@atris-agent-code/event-bus';
import { createDatabase, initializeSchema } from '@atris-agent-code/database';
import { WorkspaceManager } from './workspace-manager';

const database = createDatabase(':memory:');
initializeSchema(database.sqlite);
const bus = new LocalEventBus();
const observedStarts: unknown[] = [];
bus.on('mission_started', (event) => observedStarts.push(event));
const manager = new WorkspaceManager(database.db, bus);

const workspace = await manager.createWorkspace({ name: 'Lifecycle Test', path: process.cwd() });
await manager.createMission({
  workspaceId: workspace.id,
  title: 'Persist only',
  status: 'draft',
});

assert.equal(
  observedStarts.length,
  0,
  'WorkspaceManager persistence must not emit mission_started before Orchestrator transitions execution to running',
);

database.sqlite.close();
console.log('Mission lifecycle ownership regression test passed');
