import assert from 'node:assert/strict';
import express from 'express';
import { installGithubConnectionRoutes } from './github-connection';

let installed = false;
let authenticated = false;
let loginCount = 0;
const app = express();
installGithubConnectionRoutes(app, {
  find: async () => installed ? 'gh' : undefined,
  account: async () => { if (!authenticated) throw new Error('secret should never be exposed'); return 'example-user'; },
  login: async () => { loginCount++; },
});
const server = app.listen(0, '127.0.0.1');
try {
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/integrations/github`;
  let response = await fetch(base);
  assert.equal((await response.json() as any).status, 'not_installed');
  response = await fetch(`${base}/login`, {method:'POST'}); assert.equal(response.status, 400);
  installed = true;
  response = await fetch(base); const unverified = await response.text();
  assert.match(unverified, /unverified/); assert(!unverified.includes('secret'));
  response = await fetch(`${base}/login`, {method:'POST'}); assert.equal(response.status, 200); assert.equal(loginCount, 1);
  authenticated = true;
  response = await fetch(base); assert.deepEqual(await response.json(), {status:'connected',username:'example-user'});
  console.log('GitHub connection checks passed');
} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
