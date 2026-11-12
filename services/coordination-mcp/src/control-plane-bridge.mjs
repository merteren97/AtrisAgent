import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const endpoint = process.env.ATRIS_CONTROL_PLANE_URL || '';
const token = process.env.ATRIS_CONTROL_PLANE_TOKEN || '';
const runtimeToken = process.env.ATRIS_RUNTIME_TOKEN || '';
const manual = process.env.ATRIS_MANUAL_COORDINATION === '1';

function assertLoopbackEndpoint(value) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || hostname !== '127.0.0.1') {
    throw new Error('Atris control-plane MCP bridge only connects to an HTTP loopback endpoint.');
  }
  return url.origin;
}

if (!endpoint || !token) {
  throw new Error('ATRIS_CONTROL_PLANE_URL and ATRIS_CONTROL_PLANE_TOKEN are required.');
}

const origin = assertLoopbackEndpoint(endpoint);
const server = new Server(
  { name: 'atris-control-plane', version: '0.3.0' },
  { capabilities: { tools: {} }, ...(manual ? { instructions: 'Coordinate with other agents in this workspace. Before editing, read workspace state and messages, join with your task summary, and claim exact workspace-relative paths. Stop on conflicts and message the owner. Before builds or tests, refresh state. Release claims when finished. Do not include source code or secrets in coordination messages. Claims are advisory and cannot block shell commands or unsupported tools.' } : {}) },
);

const tools = [
  {
    name: 'agent_get_context',
    description: 'Read your server-bound mission identity, current task, active team, activity state, and unread coordination count.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_list',
    description: 'List agents in your current mission, including status, role, task, parent relationship and model when available.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_spawn',
    description: 'Delegate bounded work to a child agent. Atris enforces role, depth, parallelism, workspace isolation, and model-routing policy.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['builder', 'reviewer', 'researcher', 'qa'] },
        instruction: { type: 'string' },
        displayName: { type: 'string' },
        specialty: { type: 'string' },
        spawnReason: { type: 'string' },
        capabilities: { type: 'array', items: { type: 'string' } },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        modelCatalogId: { type: 'string', description: 'Orchestrator-only route override. Other roles are routed by Atris policy.' },
        accountProfileId: { type: 'string', description: 'Orchestrator-only account route override.' },
        reasoningLevel: { type: 'string' },
        fallbackCatalogIds: { type: 'array', items: { type: 'string' } },
        routeSelectionMode: { type: 'string', enum: ['auto', 'prefer', 'fixed'] },
      },
      required: ['role', 'instruction'],
    },
  },
  {
    name: 'agent_send_message',
    description: 'Send a provider-independent coordination message to another agent in the same mission.',
    inputSchema: {
      type: 'object',
      properties: {
        toAgentId: { type: 'string' },
        content: { type: 'string' },
        kind: { type: 'string', enum: ['message', 'handoff', 'review_request', 'summary'] },
        replyToMessageId: { type: 'string' },
      },
      required: ['toAgentId', 'content'],
    },
  },
  {
    name: 'agent_read_messages',
    description: 'Read messages addressed to your current agent identity. You cannot read another agent mailbox.',
    inputSchema: {
      type: 'object',
      properties: {
        unreadOnly: { type: 'boolean', default: true },
        markRead: { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'agent_await',
    description: 'Wait briefly for one or more agents in the same mission to complete or fail. Maximum wait per call is 20 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        agentIds: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        waitFor: { type: 'string', enum: ['all', 'any'], default: 'all' },
        timeoutMs: { type: 'number', minimum: 50, maximum: 20000 },
      },
    },
  },
  {
    name: 'agent_request_review',
    description: 'Ask an existing Reviewer or spawn an independent Reviewer for your work.',
    inputSchema: {
      type: 'object',
      properties: {
        reviewerAgentId: { type: 'string' },
        request: { type: 'string' },
        specialty: { type: 'string' },
        spawnReason: { type: 'string' },
        reasoningLevel: { type: 'string' },
      },
    },
  },
  {
    name: 'agent_handoff',
    description: 'Send a structured handoff to another same-mission agent and mark yourself waiting for that agent.',
    inputSchema: {
      type: 'object',
      properties: {
        toAgentId: { type: 'string' },
        summary: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['toAgentId', 'summary'],
    },
  },
  {
    name: 'agent_report_progress',
    description: 'Report progress for your server-bound task. The task ID cannot be overridden by the model.',
    inputSchema: {
      type: 'object',
      properties: {
        progress: { type: 'string' },
        percentage: { type: 'number', minimum: 0, maximum: 100 },
        details: { type: 'object' },
      },
      required: ['progress'],
    },
  },
  {
    name: 'agent_attach_context',
    description: 'Record that a mission/task/research/artifact context source was attached to your agent context ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        sourceType: { type: 'string' },
        sourceId: { type: 'string' },
        tokenEstimate: { type: 'number', minimum: 0 },
      },
      required: ['label', 'sourceType'],
    },
  },
  {
    name: 'workspace_get_rules',
    description: 'Read Atris workspace safety and agent concurrency policy for this runtime.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const manualTools = [
  {name:'workspace_get_state',description:'List active agents and file claims in your workspace.',inputSchema:{type:'object',properties:{}}},
  {name:'workspace_join',description:'Announce your task summary to agents in the workspace.',inputSchema:{type:'object',properties:{summary:{type:'string'}},required:['summary']}},
  {name:'workspace_claim_paths',description:'Claim workspace-relative paths atomically before editing. Stop on conflicts.',inputSchema:{type:'object',properties:{paths:{type:'array',items:{type:'string'}},intent:{type:'string'}},required:['paths','intent']}},
  {name:'workspace_release_paths',description:'Release your claims by claim ID.',inputSchema:{type:'object',properties:{claimIds:{type:'array',items:{type:'string'}}},required:['claimIds']}},
  {name:'workspace_send_message',description:'Send a brief message to an agent, or broadcast to the workspace.',inputSchema:{type:'object',properties:{toAgentId:{type:'string'},body:{type:'string'}},required:['body']}},
  {name:'workspace_read_messages',description:'Read unread coordination messages for your session.',inputSchema:{type:'object',properties:{}}},
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: manual ? manualTools : tools }));

async function manualHeartbeat() {
  try {
    await fetch(`${origin}/api/internal/manual-coordination/call`, {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(runtimeToken ? {'X-Atris-Runtime-Token':runtimeToken} : {})},body:JSON.stringify({tool:'heartbeat'}),signal:AbortSignal.timeout(5000)});
  } catch { /* A later heartbeat can recover until the lease expires. */ }
}
if (manual) {
  void manualHeartbeat();
  const heartbeat = setInterval(manualHeartbeat, 20_000);
  heartbeat.unref();
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${origin}${manual ? '/api/internal/manual-coordination/call' : '/api/internal/control-plane/call'}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(runtimeToken ? { 'X-Atris-Runtime-Token': runtimeToken } : {}),
      },
      body: JSON.stringify({
        tool: request.params.name,
        arguments: request.params.arguments || {},
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!response.ok || payload?.ok === false) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: payload?.error || `HTTP ${response.status}` }) }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(payload.result ?? null, null, 2) }],
    };
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Atris control-plane request timed out.'
      : error?.message || String(error);
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
  } finally {
    clearTimeout(timer);
  }
});

await server.connect(new StdioServerTransport());
