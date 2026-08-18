import type { PlaygroundScenario } from './types';

export const PLAYGROUND_SCENARIOS: PlaygroundScenario[] = [
  {
    id: 'fullstack-refactor',
    title: {
      tr: 'Full-Stack Refactor & Server Actions',
      en: 'Full-Stack Refactor & Server Actions',
    },
    badge: {
      tr: 'Next.js App Router',
      en: 'Next.js App Router',
    },
    description: {
      tr: 'Eski Pages API rotasını Zod doğrulamalı, streaming yanıtlı ve oturum kontrollü Next.js Server Action mimarisine dönüştürür.',
      en: 'Migrate legacy Pages API handler to type-safe streaming Next.js Server Actions with granular session boundaries.',
    },
    prompt: 'Refactor /api/analytics/export to Next.js Server Actions with zod validation and stream chunks.',
    defaultTrustMode: 'Balanced',
    defaultRuntime: 'Codex CLI',
    workspaceName: 'next-enterprise-dashboard',
    branchName: 'feat/app-router-actions',
    estimatedTokens: 2480,
    initialAgents: [
      {
        id: 'agent-orch-1',
        role: 'orchestrator',
        name: 'Orchestrator',
        runtime: 'Codex CLI',
        status: 'idle',
        currentTask: 'Waiting for task decomposition',
        avatarColor: '#8b5cf6',
      },
      {
        id: 'agent-build-1',
        role: 'builder',
        name: 'Builder',
        runtime: 'Antigravity CLI',
        status: 'idle',
        currentTask: 'Standby for worktree implementation',
        avatarColor: '#3b82f6',
      },
      {
        id: 'agent-qa-1',
        role: 'qa',
        name: 'QA Engineer',
        runtime: 'Claude Code',
        status: 'idle',
        currentTask: 'Ready for typecheck & unit test runner',
        avatarColor: '#06b6d4',
      },
      {
        id: 'agent-rev-1',
        role: 'reviewer',
        name: 'Reviewer',
        runtime: 'Codex CLI',
        status: 'idle',
        currentTask: 'Waiting for final review pack',
        avatarColor: '#f59e0b',
      },
    ],
    planTasks: [
      {
        id: 'task-1',
        title: 'Inspect legacy Pages handler & map dependencies',
        assignedRole: 'orchestrator',
        status: 'pending',
        summary: 'Analyze pages/api/analytics/export.ts and session middlewares.',
      },
      {
        id: 'task-2',
        title: 'Implement zod-validated Server Action & stream buffer',
        assignedRole: 'builder',
        status: 'pending',
        dependencies: ['task-1'],
        summary: 'Create src/actions/export-analytics.ts with exportAnalyticsStream action.',
      },
      {
        id: 'task-3',
        title: 'Run TypeScript compiler & RSC boundary verification',
        assignedRole: 'qa',
        status: 'pending',
        dependencies: ['task-2'],
        summary: 'Verify zero hydration mismatch and execute 14 export unit tests.',
      },
      {
        id: 'task-4',
        title: 'Review bundle impact and approve isolated worktree merge',
        assignedRole: 'reviewer',
        status: 'pending',
        dependencies: ['task-3'],
        summary: 'Inspect client bundle size delta (-14.2 KB) and sign off.',
      },
    ],
    events: [
      {
        id: 'ev-1',
        type: 'thought',
        agentRole: 'orchestrator',
        content: 'Analyzing the mission requirement: `/api/analytics/export` needs to be refactored into a type-safe Server Action using Zod validation and streaming NDJSON chunks.',
        timestamp: '10:42:01',
      },
      {
        id: 'ev-2',
        type: 'tool_call',
        agentRole: 'orchestrator',
        content: 'Searching codebase for legacy session usage and export routes.',
        timestamp: '10:42:03',
        toolData: {
          name: 'grep_search',
          args: { SearchPath: 'src/pages/api', Query: 'export' },
          output: 'Found 1 file matching: pages/api/analytics/export.ts:12 (NextApiRequest, NextApiResponse)',
          status: 'success',
          duration: '118ms',
        },
      },
      {
        id: 'ev-3',
        type: 'plan_generated',
        agentRole: 'orchestrator',
        content: 'Decomposed full-stack refactor into 4 sequential stages. Builder will receive isolated worktree `worktrees/feat-app-router`.',
        timestamp: '10:42:06',
      },
      {
        id: 'ev-4',
        type: 'thought',
        agentRole: 'builder',
        content: 'Constructing `src/actions/export-analytics.ts` with "use server", input validation schema via Zod, and streaming chunk generation.',
        timestamp: '10:42:09',
      },
      {
        id: 'ev-5',
        type: 'tool_call',
        agentRole: 'builder',
        content: 'Replacing legacy handler with server action and client hook integration.',
        timestamp: '10:42:12',
        toolData: {
          name: 'replace_file_content',
          args: {
            TargetFile: 'src/actions/export-analytics.ts',
            Instruction: 'Create streaming server action with session gate',
          },
          output: 'Successfully applied unified hunk: +42 lines, -18 lines in src/actions/export-analytics.ts',
          status: 'success',
          duration: '240ms',
        },
      },
      {
        id: 'ev-6',
        type: 'file_change',
        agentRole: 'builder',
        content: 'Refactored `src/actions/export-analytics.ts` and updated `src/hooks/use-export.ts`.',
        timestamp: '10:42:15',
        diffData: {
          path: 'src/actions/export-analytics.ts',
          status: 'modified',
          additions: 42,
          deletions: 18,
          diffSnippet: `@@ -1,18 +1,42 @@
-"use client";
-import type { NextApiRequest, NextApiResponse } from "next";
-
-export default async function handler(req: NextApiRequest, res: NextApiResponse) {
-  if (req.method !== "POST") return res.status(405).end();
-  const data = await queryDatabase(req.body);
-  return res.json({ ok: true, data });
-}
+"use server";
+import { z } from "zod";
+import { auth } from "@/lib/auth";
+import { createAnalyticsStream } from "@/server/analytics";
+
+const ExportQuerySchema = z.object({
+  dateRange: z.enum(["7d", "30d", "90d", "all"]),
+  format: z.enum(["csv", "json", "parquet"]),
+  filterTags: z.array(z.string()).default([]),
+});
+
+export type ExportQuery = z.infer<typeof ExportQuerySchema>;
+
+export async function exportAnalyticsAction(input: ExportQuery) {
+  const session = await auth();
+  if (!session?.user?.id) throw new Error("UNAUTHORIZED_ACCESS");
+
+  const parsed = ExportQuerySchema.parse(input);
+  const stream = await createAnalyticsStream({
+    tenantId: session.user.tenantId,
+    ...parsed,
+  });
+
+  return { success: true, streamId: stream.id };
+}`,
        },
      },
      {
        id: 'ev-7',
        type: 'thought',
        agentRole: 'qa',
        content: 'Running automated validation: TypeScript strict check, Next.js RSC boundary linter, and Vitest suite.',
        timestamp: '10:42:18',
      },
      {
        id: 'ev-8',
        type: 'tool_call',
        agentRole: 'qa',
        content: 'Executing compiler & unit test runner.',
        timestamp: '10:42:20',
        toolData: {
          name: 'run_command',
          args: { CommandLine: 'pnpm exec tsc --noEmit && vitest run test/actions/export.test.ts' },
          output: '✓ 14 passing tests (412ms)\n✓ TypeScript exited with code 0\n✓ Zero client-side leakage detected in Server Action',
          status: 'success',
          duration: '620ms',
        },
      },
      {
        id: 'ev-9',
        type: 'qa_check',
        agentRole: 'qa',
        content: 'All 14 unit tests passed. Server Action boundary verified.',
        timestamp: '10:42:22',
        checkData: {
          id: 'qa-check-1',
          name: 'Server Action Streaming & Auth Gate',
          passed: true,
          summary: '14/14 tests passed. Auth guard blocks unauthenticated requests; Zod rejects malformed payloads.',
          timestamp: '10:42:22',
          category: 'unit',
        },
      },
      {
        id: 'ev-10',
        type: 'thought',
        agentRole: 'reviewer',
        content: 'Inspecting bundle metrics and diff safety. Client bundle shrank by 14.2 KB by eliminating legacy polyfills.',
        timestamp: '10:42:25',
      },
      {
        id: 'ev-11',
        type: 'mission_summary',
        agentRole: 'orchestrator',
        content: 'Full-Stack Refactor successfully completed. Server Actions are production-ready with streaming response and 100% type safety.',
        timestamp: '10:42:28',
        tokens: 2480,
      },
    ],
    finalDiffs: [
      {
        path: 'src/actions/export-analytics.ts',
        status: 'modified',
        additions: 42,
        deletions: 18,
        diffSnippet: `@@ -1,18 +1,42 @@
-"use client";
-import type { NextApiRequest, NextApiResponse } from "next";
-
-export default async function handler(req: NextApiRequest, res: NextApiResponse) {
-  if (req.method !== "POST") return res.status(405).end();
-  const data = await queryDatabase(req.body);
-  return res.json({ ok: true, data });
-}
+"use server";
+import { z } from "zod";
+import { auth } from "@/lib/auth";
+import { createAnalyticsStream } from "@/server/analytics";
+
+const ExportQuerySchema = z.object({
+  dateRange: z.enum(["7d", "30d", "90d", "all"]),
+  format: z.enum(["csv", "json", "parquet"]),
+  filterTags: z.array(z.string()).default([]),
+});
+
+export type ExportQuery = z.infer<typeof ExportQuerySchema>;
+
+export async function exportAnalyticsAction(input: ExportQuery) {
+  const session = await auth();
+  if (!session?.user?.id) throw new Error("UNAUTHORIZED_ACCESS");
+
+  const parsed = ExportQuerySchema.parse(input);
+  const stream = await createAnalyticsStream({
+    tenantId: session.user.tenantId,
+    ...parsed,
+  });
+
+  return { success: true, streamId: stream.id };
+}`,
      },
      {
        path: 'src/hooks/use-analytics-export.ts',
        status: 'modified',
        additions: 19,
        deletions: 8,
        diffSnippet: `@@ -12,8 +12,19 @@
-export function useAnalyticsExport() {
-  const trigger = async (payload) => {
-    const res = await fetch("/api/analytics/export", { method: "POST", body: JSON.stringify(payload) });
-    return res.json();
-  };
+export function useAnalyticsExport() {
+  const [isPending, startTransition] = useTransition();
+  const [state, formAction] = useActionState(exportAnalyticsAction, null);
+
+  const trigger = (params: ExportQuery) => {
+    startTransition(async () => {
+      await exportAnalyticsAction(params);
+    });
+  };
+  return { trigger, isPending, state };
 }`,
      },
    ],
    qaChecks: [
      {
        id: 'check-1',
        name: 'Typecheck & RSC Boundary Lint',
        passed: true,
        summary: 'Zero TypeScript diagnostics. Strict RSC boundary maintained.',
        timestamp: '10:42:21',
        category: 'typecheck',
      },
      {
        id: 'check-2',
        name: 'Server Action Unit & Auth Suite',
        passed: true,
        summary: '14/14 tests passed (session expiration, payload validation, stream chunking).',
        timestamp: '10:42:22',
        category: 'unit',
      },
    ],
  },

  {
    id: 'race-condition-fix',
    title: {
      tr: 'Race Condition Bug Fix & Atomic Lock',
      en: 'Race Condition Bug Fix & Atomic Lock',
    },
    badge: {
      tr: 'Realtime Engine',
      en: 'Realtime Engine',
    },
    description: {
      tr: 'Eşzamanlı WebSocket telemetri akışlarındaki sıra dışı veri kaybı hatasını AsyncSequenceMutex ve atomic sequence counter ile çözer.',
      en: 'Resolve intermittent out-of-order telemetry packet drops using AsyncSequenceMutex and strict monotonic sequence counters.',
    },
    prompt: 'Fix concurrent telemetry event race condition in session-dispatcher.ts under high throughput.',
    defaultTrustMode: 'Balanced',
    defaultRuntime: 'Codex CLI',
    workspaceName: 'atris-realtime-engine',
    branchName: 'fix/ws-sequence-deadlock',
    estimatedTokens: 3120,
    initialAgents: [
      {
        id: 'agent-orch-2',
        role: 'orchestrator',
        name: 'Orchestrator',
        runtime: 'Codex CLI',
        status: 'idle',
        currentTask: 'Reviewing reproduction logs',
        avatarColor: '#8b5cf6',
      },
      {
        id: 'agent-res-2',
        role: 'researcher',
        name: 'Researcher',
        runtime: 'Claude Code',
        status: 'idle',
        currentTask: 'Pinpointing unsynchronized event loop',
        avatarColor: '#10b981',
      },
      {
        id: 'agent-build-2',
        role: 'builder',
        name: 'Builder',
        runtime: 'Antigravity CLI',
        status: 'idle',
        currentTask: 'Implementing atomic mutex queue',
        avatarColor: '#3b82f6',
      },
      {
        id: 'agent-qa-2',
        role: 'qa',
        name: 'QA Chaos Tester',
        runtime: 'Codex CLI',
        status: 'idle',
        currentTask: 'Running 500-thread concurrency chaos suite',
        avatarColor: '#06b6d4',
      },
    ],
    planTasks: [
      {
        id: 'rc-1',
        title: 'Reproduce concurrency race with parallel packet generator',
        assignedRole: 'researcher',
        status: 'pending',
        summary: 'Simulate 500 simultaneous WebSocket frames arriving in 2ms intervals.',
      },
      {
        id: 'rc-2',
        title: 'Implement AsyncSequenceMutex with backpressure ring buffer',
        assignedRole: 'builder',
        status: 'pending',
        dependencies: ['rc-1'],
        summary: 'Replace direct promise dispatch with monotonic ordered lock in session-dispatcher.ts.',
      },
      {
        id: 'rc-3',
        title: 'Run concurrency chaos tests and verify zero dropped frames',
        assignedRole: 'qa',
        status: 'pending',
        dependencies: ['rc-2'],
        summary: 'Verify 100% monotonic sequence order under 10k ops/sec load.',
      },
    ],
    events: [
      {
        id: 'rc-ev-1',
        type: 'thought',
        agentRole: 'orchestrator',
        content: 'Issue report: Multiple telemetry frames emitted during agent swarm execution are occasionally processed out-of-order in `session-dispatcher.ts`.',
        timestamp: '14:15:02',
      },
      {
        id: 'rc-ev-2',
        type: 'thought',
        agentRole: 'researcher',
        content: 'Root cause identified: `dispatchFrame()` invokes an async generator without an acquisition lock, leading to promise race when network latency fluctuates.',
        timestamp: '14:15:05',
      },
      {
        id: 'rc-ev-3',
        type: 'tool_call',
        agentRole: 'researcher',
        content: 'Inspecting event dispatch pipeline in packages/core/dispatcher.ts.',
        timestamp: '14:15:07',
        toolData: {
          name: 'grep_search',
          args: { SearchPath: 'packages/core', Query: 'dispatchFrame' },
          output: 'packages/core/dispatcher.ts:47: async function dispatchFrame(frame: WSFrame)',
          status: 'success',
          duration: '82ms',
        },
      },
      {
        id: 'rc-ev-4',
        type: 'plan_generated',
        agentRole: 'orchestrator',
        content: 'Created plan: Introduce `AsyncSequenceMutex` to guarantee FIFO monotonic delivery while preserving high throughput.',
        timestamp: '14:15:10',
      },
      {
        id: 'rc-ev-5',
        type: 'thought',
        agentRole: 'builder',
        content: 'Refactoring `dispatcher.ts`: Wrapping frame handlers with a lightweight chained Promise queue and sequence validation counter.',
        timestamp: '14:15:13',
      },
      {
        id: 'rc-ev-6',
        type: 'tool_call',
        agentRole: 'builder',
        content: 'Applying atomic FIFO lock patch to dispatcher.',
        timestamp: '14:15:16',
        toolData: {
          name: 'replace_file_content',
          args: {
            TargetFile: 'packages/core/dispatcher.ts',
            Instruction: 'Add AsyncSequenceMutex and sequential dispatch guard',
          },
          output: 'Applied patch to packages/core/dispatcher.ts (+36, -9 lines)',
          status: 'success',
          duration: '195ms',
        },
      },
      {
        id: 'rc-ev-7',
        type: 'file_change',
        agentRole: 'builder',
        content: 'Updated `packages/core/dispatcher.ts` with sequence mutex guard.',
        timestamp: '14:15:18',
        diffData: {
          path: 'packages/core/dispatcher.ts',
          status: 'modified',
          additions: 36,
          deletions: 9,
          diffSnippet: `@@ -45,9 +45,36 @@
-  async dispatchFrame(frame: WSFrame): Promise<void> {
-    // Unsynchronized async dispatch causing race condition
-    await this.processPayload(frame.payload);
-    this.lastSequence = frame.sequenceId;
-  }
+  private sequenceLock: Promise<void> = Promise.resolve();
+  private expectedSequence = 0;
+
+  async dispatchFrame(frame: WSFrame): Promise<void> {
+    // Acquire FIFO lock to ensure monotonic sequence order
+    const nextLock = this.sequenceLock.then(async () => {
+      if (frame.sequenceId < this.expectedSequence) {
+        console.warn(\`Duplicate or stale frame rejected: \${frame.sequenceId}\`);
+        return;
+      }
+      await this.processPayload(frame.payload);
+      this.expectedSequence = frame.sequenceId + 1;
+      this.emit("frame:processed", { seq: frame.sequenceId, latency: Date.now() - frame.ts });
+    });
+
+    this.sequenceLock = nextLock.catch((err) => {
+      console.error("Frame processing error in pipeline:", err);
+    });
+
+    return nextLock;
+  }`,
        },
      },
      {
        id: 'rc-ev-8',
        type: 'thought',
        agentRole: 'qa',
        content: 'Executing Concurrency Chaos Test Suite: 8 workers generating 1,000 concurrent out-of-order packets.',
        timestamp: '14:15:21',
      },
      {
        id: 'rc-ev-9',
        type: 'tool_call',
        agentRole: 'qa',
        content: 'Running chaos load test suite.',
        timestamp: '14:15:23',
        toolData: {
          name: 'run_command',
          args: { CommandLine: 'pnpm test:concurrency --threads=8 --iterations=1000' },
          output: '✓ 1,000/1,000 frames processed in exact monotonic order (0 dropped)\n✓ Mean processing latency: 0.18ms\n✓ Deadlock recovery: PASS',
          status: 'success',
          duration: '850ms',
        },
      },
      {
        id: 'rc-ev-10',
        type: 'qa_check',
        agentRole: 'qa',
        content: 'Zero frame drop verified under 10k frames/sec pressure.',
        timestamp: '14:15:26',
        checkData: {
          id: 'qa-check-rc',
          name: 'Monotonic Sequence & Zero Race Condition',
          passed: true,
          summary: '1,000 parallel test frames processed with 0 drops and 0 sequence violations.',
          timestamp: '14:15:26',
          category: 'performance',
        },
      },
      {
        id: 'rc-ev-11',
        type: 'mission_summary',
        agentRole: 'orchestrator',
        content: 'Race condition completely resolved. Realtime packet dispatcher is atomic, deadlock-free, and handles high burst volume.',
        timestamp: '14:15:29',
        tokens: 3120,
      },
    ],
    finalDiffs: [
      {
        path: 'packages/core/dispatcher.ts',
        status: 'modified',
        additions: 36,
        deletions: 9,
        diffSnippet: `@@ -45,9 +45,36 @@
-  async dispatchFrame(frame: WSFrame): Promise<void> {
-    // Unsynchronized async dispatch causing race condition
-    await this.processPayload(frame.payload);
-    this.lastSequence = frame.sequenceId;
-  }
+  private sequenceLock: Promise<void> = Promise.resolve();
+  private expectedSequence = 0;
+
+  async dispatchFrame(frame: WSFrame): Promise<void> {
+    // Acquire FIFO lock to ensure monotonic sequence order
+    const nextLock = this.sequenceLock.then(async () => {
+      if (frame.sequenceId < this.expectedSequence) {
+        console.warn(\`Duplicate or stale frame rejected: \${frame.sequenceId}\`);
+        return;
+      }
+      await this.processPayload(frame.payload);
+      this.expectedSequence = frame.sequenceId + 1;
+      this.emit("frame:processed", { seq: frame.sequenceId, latency: Date.now() - frame.ts });
+    });
+
+    this.sequenceLock = nextLock.catch((err) => {
+      console.error("Frame processing error in pipeline:", err);
+    });
+
+    return nextLock;
+  }`,
      },
    ],
    qaChecks: [
      {
        id: 'check-rc-1',
        name: 'Monotonic Sequence Integrity Test',
        passed: true,
        summary: '1,000/1,000 frames arrived and committed in strict monotonic order.',
        timestamp: '14:15:25',
        category: 'integration',
      },
      {
        id: 'check-rc-2',
        name: 'Deadlock & Backpressure Verification',
        passed: true,
        summary: 'Zero thread deadlocks observed; queue backpressure bounded to 50 items.',
        timestamp: '14:15:26',
        category: 'performance',
      },
    ],
  },

  {
    id: 'security-audit-approval',
    title: {
      tr: 'Security Audit & Approval Gate',
      en: 'Security Audit & Approval Gate',
    },
    badge: {
      tr: 'Trust Mode: Review Driven',
      en: 'Trust Mode: Review Driven',
    },
    description: {
      tr: 'Webhook proxy üzerindeki SSRF açığını tespit edip RFC 1918 CIDR filtresi uygular; restricted shell kuralı için açık onay ister.',
      en: 'Detect SSRF vulnerability in webhook proxy, implement CIDR egress filtering, and pause for explicit restricted shell approval.',
    },
    prompt: 'Audit webhook proxy for SSRF vulnerabilities and configure container egress security rules.',
    defaultTrustMode: 'Review Driven',
    defaultRuntime: 'Claude Code',
    workspaceName: 'cloud-agent-gateway',
    branchName: 'sec/sandbox-policy-enforcement',
    estimatedTokens: 2890,
    initialAgents: [
      {
        id: 'agent-orch-3',
        role: 'orchestrator',
        name: 'Orchestrator',
        runtime: 'Claude Code',
        status: 'idle',
        currentTask: 'Initializing security audit pipeline',
        avatarColor: '#8b5cf6',
      },
      {
        id: 'agent-build-3',
        role: 'builder',
        name: 'Security Engineer',
        runtime: 'Antigravity CLI',
        status: 'idle',
        currentTask: 'Constructing egress firewall filter',
        avatarColor: '#3b82f6',
      },
      {
        id: 'agent-qa-3',
        role: 'qa',
        name: 'Penetration Tester',
        runtime: 'Codex CLI',
        status: 'idle',
        currentTask: 'Compiling SSRF payload exploit suite',
        avatarColor: '#06b6d4',
      },
      {
        id: 'agent-rev-3',
        role: 'reviewer',
        name: 'Security Reviewer',
        runtime: 'Codex CLI',
        status: 'idle',
        currentTask: 'Awaiting audit approval verification',
        avatarColor: '#f59e0b',
      },
    ],
    planTasks: [
      {
        id: 'sec-1',
        title: 'Audit outbound webhook proxy for SSRF & loopback bypass',
        assignedRole: 'orchestrator',
        status: 'pending',
        summary: 'Scan services/gateway/webhook-proxy.ts for unvalidated fetch destinations.',
      },
      {
        id: 'sec-2',
        title: 'Patch private CIDR blocklist (RFC 1918, RFC 6598, AWS metadata)',
        assignedRole: 'builder',
        status: 'pending',
        dependencies: ['sec-1'],
        summary: 'Ensure IP resolution happens before socket connect to prevent DNS rebinding.',
      },
      {
        id: 'sec-3',
        title: 'Request user approval to apply system-level egress firewall rules',
        assignedRole: 'orchestrator',
        status: 'pending',
        dependencies: ['sec-2'],
        summary: 'Restricted command requires explicit interactive approval in Review Driven mode.',
      },
      {
        id: 'sec-4',
        title: 'Execute penetration attack test suite with 28 SSRF payloads',
        assignedRole: 'qa',
        status: 'pending',
        dependencies: ['sec-3'],
        summary: 'Verify 100% of internal metadata and loopback requests are rejected.',
      },
    ],
    events: [
      {
        id: 'sec-ev-1',
        type: 'thought',
        agentRole: 'orchestrator',
        content: 'Running automated security preflight on `cloud-agent-gateway`. Webhook dispatcher allows arbitrary URLs provided by external integrations.',
        timestamp: '16:02:11',
      },
      {
        id: 'sec-ev-2',
        type: 'tool_call',
        agentRole: 'orchestrator',
        content: 'Searching for raw fetch calls without egress validation.',
        timestamp: '16:02:14',
        toolData: {
          name: 'grep_search',
          args: { SearchPath: 'services/gateway', Query: 'fetch(targetUrl' },
          output: 'services/gateway/webhook-proxy.ts:24: const res = await fetch(targetUrl, { method: "POST", body });',
          status: 'success',
          duration: '94ms',
        },
      },
      {
        id: 'sec-ev-3',
        type: 'thought',
        agentRole: 'builder',
        content: 'Designing SSRF Defense: Adding `isPrivateOrReservedIP()` check that resolves DNS records first, validating against 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, and 169.254.169.254 (Cloud Metadata).',
        timestamp: '16:02:17',
      },
      {
        id: 'sec-ev-4',
        type: 'tool_call',
        agentRole: 'builder',
        content: 'Injecting DNS pre-validation guard in webhook proxy.',
        timestamp: '16:02:20',
        toolData: {
          name: 'replace_file_content',
          args: {
            TargetFile: 'services/gateway/webhook-proxy.ts',
            Instruction: 'Add safeEgressFetch with DNS rebinding protection',
          },
          output: 'Modified services/gateway/webhook-proxy.ts (+31, -4 lines)',
          status: 'success',
          duration: '210ms',
        },
      },
      {
        id: 'sec-ev-5',
        type: 'file_change',
        agentRole: 'builder',
        content: 'Patched `services/gateway/webhook-proxy.ts` with CIDR filter.',
        timestamp: '16:02:22',
        diffData: {
          path: 'services/gateway/webhook-proxy.ts',
          status: 'modified',
          additions: 31,
          deletions: 4,
          diffSnippet: `@@ -22,4 +22,31 @@
-  const res = await fetch(targetUrl, { method: "POST", body });
-  return res.json();
+  const parsedUrl = new URL(targetUrl);
+  const resolvedIPs = await dns.promises.resolve4(parsedUrl.hostname);
+
+  for (const ip of resolvedIPs) {
+    if (isPrivateOrReservedIP(ip)) {
+      throw new SecurityViolationError(
+        \`Outbound connection to private IP \${ip} is strictly forbidden by policy.\`
+      );
+    }
+  }
+
+  const agent = new http.Agent({ lookup: (_, __, cb) => cb(null, resolvedIPs[0], 4) });
+  const res = await fetch(targetUrl, { method: "POST", body, agent });
+  return res.json();`,
        },
      },
      {
        id: 'sec-ev-6',
        type: 'approval_request',
        agentRole: 'orchestrator',
        content: 'Interactive approval required: Builder wants to execute system-level egress firewall configuration.',
        timestamp: '16:02:25',
        approvalData: {
          id: 'appr-sec-01',
          type: 'security_elevation',
          title: 'Apply Sandbox Egress Firewall Rules',
          description: 'The Builder is requesting permission to execute `sudo iptables-restore < /etc/sandbox/sec.rules` to enforce kernel-level loopback isolation.',
          command: 'sudo iptables-restore < /etc/sandbox/sec.rules',
          riskLevel: 'high',
          affectedFiles: ['/etc/sandbox/sec.rules', 'services/gateway/webhook-proxy.ts'],
        },
      },
      {
        id: 'sec-ev-7',
        type: 'thought',
        agentRole: 'qa',
        content: 'Executing SSRF penetration suite: Testing AWS metadata (169.254.169.254), loopback (127.0.0.1, 0.0.0.0), and DNS rebinding payloads.',
        timestamp: '16:02:28',
      },
      {
        id: 'sec-ev-8',
        type: 'tool_call',
        agentRole: 'qa',
        content: 'Running automated penetration test runner.',
        timestamp: '16:02:30',
        toolData: {
          name: 'run_command',
          args: { CommandLine: 'pnpm test:sec-audit --suite=ssrf-exploit' },
          output: '✓ 28/28 exploit payloads blocked with SecurityViolationError\n✓ AWS IMDSv2 metadata probe: REJECTED (0.01ms)\n✓ DNS rebinding simulation: REJECTED (IP changed to 127.0.0.1)',
          status: 'success',
          duration: '740ms',
        },
      },
      {
        id: 'sec-ev-9',
        type: 'qa_check',
        agentRole: 'qa',
        content: 'SSRF audit complete: 100% exploit vectors neutralized.',
        timestamp: '16:02:32',
        checkData: {
          id: 'qa-check-sec',
          name: 'SSRF & Egress Boundary Penetration Suite',
          passed: true,
          summary: '28/28 attack vectors blocked. Cloud metadata & RFC 1918 egress completely insulated.',
          timestamp: '16:02:32',
          category: 'security',
        },
      },
      {
        id: 'sec-ev-10',
        type: 'mission_summary',
        agentRole: 'orchestrator',
        content: 'Security audit and approval workflow completed. Policy boundary verified with zero regressions.',
        timestamp: '16:02:35',
        tokens: 2890,
      },
    ],
    finalDiffs: [
      {
        path: 'services/gateway/webhook-proxy.ts',
        status: 'modified',
        additions: 31,
        deletions: 4,
        diffSnippet: `@@ -22,4 +22,31 @@
-  const res = await fetch(targetUrl, { method: "POST", body });
-  return res.json();
+  const parsedUrl = new URL(targetUrl);
+  const resolvedIPs = await dns.promises.resolve4(parsedUrl.hostname);
+
+  for (const ip of resolvedIPs) {
+    if (isPrivateOrReservedIP(ip)) {
+      throw new SecurityViolationError(
+        \`Outbound connection to private IP \${ip} is strictly forbidden by policy.\`
+      );
+    }
+  }
+
+  const agent = new http.Agent({ lookup: (_, __, cb) => cb(null, resolvedIPs[0], 4) });
+  const res = await fetch(targetUrl, { method: "POST", body, agent });
+  return res.json();`,
      },
    ],
    qaChecks: [
      {
        id: 'check-sec-1',
        name: 'Private CIDR Filter (RFC 1918 / 6598)',
        passed: true,
        summary: 'All RFC 1918 private subnets successfully blocked.',
        timestamp: '16:02:31',
        category: 'security',
      },
      {
        id: 'check-sec-2',
        name: 'AWS/GCP Cloud Metadata Access Attempt',
        passed: true,
        summary: '169.254.169.254 blocked with immediate SecurityViolationError.',
        timestamp: '16:02:32',
        category: 'security',
      },
    ],
  },

  {
    id: 'multi-agent-candidate',
    title: {
      tr: 'Multi-Agent Candidate Evaluation',
      en: 'Multi-Agent Candidate Evaluation',
    },
    badge: {
      tr: 'Trust Mode: Candidate',
      en: 'Trust Mode: Candidate',
    },
    description: {
      tr: 'İki rakip mimariyi (HNSW Graph vs Quantized IVF) izole worktree\'lerde paralel çalıştırır, benchmark puanlarına göre kazananı seçer.',
      en: 'Run two parallel candidate implementations (HNSW Graph vs Quantized IVF) in isolated worktrees and evaluate with live benchmarks.',
    },
    prompt: 'Benchmark and select optimal vector indexing strategy for 1M embeddings (HNSW vs IVF-PQ).',
    defaultTrustMode: 'Candidate',
    defaultRuntime: 'Codex CLI',
    workspaceName: 'atris-vector-search',
    branchName: 'perf/vector-indexing-benchmark',
    estimatedTokens: 3840,
    initialAgents: [
      {
        id: 'agent-orch-4',
        role: 'orchestrator',
        name: 'Orchestrator',
        runtime: 'Codex CLI',
        status: 'idle',
        currentTask: 'Spawning parallel candidate worktrees',
        avatarColor: '#8b5cf6',
      },
      {
        id: 'agent-cand-a',
        role: 'builder',
        name: 'Candidate A (Codex)',
        runtime: 'Codex CLI',
        status: 'idle',
        currentTask: 'Implementing SIMD AVX-512 HNSW indexer',
        avatarColor: '#3b82f6',
        isCandidate: true,
      },
      {
        id: 'agent-cand-b',
        role: 'builder_b',
        name: 'Candidate B (Claude)',
        runtime: 'Claude Code',
        status: 'idle',
        currentTask: 'Implementing Scalar Quantized IVF indexer',
        avatarColor: '#10b981',
        isCandidate: true,
      },
      {
        id: 'agent-qa-4',
        role: 'qa',
        name: 'Benchmark Evaluator',
        runtime: 'Antigravity CLI',
        status: 'idle',
        currentTask: 'Running recall vs latency benchmark suite',
        avatarColor: '#06b6d4',
      },
      {
        id: 'agent-rev-4',
        role: 'reviewer',
        name: 'Merge Coordinator',
        runtime: 'Codex CLI',
        status: 'idle',
        currentTask: 'Awaiting candidate selection decision',
        avatarColor: '#f59e0b',
      },
    ],
    planTasks: [
      {
        id: 'cand-1',
        title: 'Provision isolated worktrees: candidate-a and candidate-b',
        assignedRole: 'orchestrator',
        status: 'pending',
        summary: 'Create git worktrees for isolated parallel builder execution.',
      },
      {
        id: 'cand-2',
        title: 'Candidate A: Implement SIMD AVX-512 Cosine HNSW Graph',
        assignedRole: 'builder',
        status: 'pending',
        dependencies: ['cand-1'],
        summary: 'Target maximum recall rate (worktrees/candidate-a).',
      },
      {
        id: 'cand-3',
        title: 'Candidate B: Implement 8-Bit Product Quantized IVF Index',
        assignedRole: 'builder_b',
        status: 'pending',
        dependencies: ['cand-1'],
        summary: 'Target ultra-low memory & fast query throughput (worktrees/candidate-b).',
      },
      {
        id: 'cand-4',
        title: 'Run comparative benchmark on 1,000,000 synthetic embeddings',
        assignedRole: 'qa',
        status: 'pending',
        dependencies: ['cand-2', 'cand-3'],
        summary: 'Evaluate recall@10, QPS, latency p99, and memory footprint.',
      },
      {
        id: 'cand-5',
        title: 'Orchestrator merge candidate winner into main branch',
        assignedRole: 'reviewer',
        status: 'pending',
        dependencies: ['cand-4'],
        summary: 'Merge selected winner with automated rollback checkpoint.',
      },
    ],
    events: [
      {
        id: 'cand-ev-1',
        type: 'thought',
        agentRole: 'orchestrator',
        content: 'Candidate Mode Active: Provisioning two isolated worktrees to pit Candidate A (Codex CLI) against Candidate B (Claude Code).',
        timestamp: '18:30:00',
      },
      {
        id: 'cand-ev-2',
        type: 'tool_call',
        agentRole: 'orchestrator',
        content: 'Spawning parallel git worktrees.',
        timestamp: '18:30:03',
        toolData: {
          name: 'run_command',
          args: { CommandLine: 'git worktree add .atris/worktrees/cand-a && git worktree add .atris/worktrees/cand-b' },
          output: 'Prepared worktree at .atris/worktrees/cand-a (HEAD feat/hnsw)\nPrepared worktree at .atris/worktrees/cand-b (HEAD feat/ivf-pq)',
          status: 'success',
          duration: '310ms',
        },
      },
      {
        id: 'cand-ev-3',
        type: 'thought',
        agentRole: 'builder',
        content: 'Candidate A (Codex): Building HNSW index with M=16, efConstruction=200 and AVX-512 distance kernels.',
        timestamp: '18:30:07',
      },
      {
        id: 'cand-ev-4',
        type: 'thought',
        agentRole: 'builder_b',
        content: 'Candidate B (Claude Code): Building IVF-PQ index with 1024 Voronoi centroids and 8-bit scalar quantization for 4x memory savings.',
        timestamp: '18:30:10',
      },
      {
        id: 'cand-ev-5',
        type: 'tool_call',
        agentRole: 'qa',
        content: 'Running parallel benchmark against 1,000,000 1536-dimensional embeddings.',
        timestamp: '18:30:14',
        toolData: {
          name: 'run_command',
          args: { CommandLine: 'cargo bench --bench vector_index -- --dataset=synthetic-1m' },
          output: 'Candidate A: 12.4ms query latency, 420MB RAM, 99.4% recall@10\nCandidate B: 3.8ms query latency, 95MB RAM, 95.2% recall@10 (3.2x faster)',
          status: 'success',
          duration: '1120ms',
        },
      },
      {
        id: 'cand-ev-6',
        type: 'candidate_comparison',
        agentRole: 'orchestrator',
        content: 'Candidate Evaluation Completed: Comparing benchmark telemetry from isolated worktrees.',
        timestamp: '18:30:18',
        candidateData: {
          selectedCandidateId: 'cand-b',
          summary: 'Candidate B (Claude Code) won with 3.2x lower query latency and 77% memory reduction while maintaining 95.2% recall.',
          candidates: [
            {
              id: 'cand-a',
              name: 'Candidate A (HNSW Graph)',
              runtime: 'Codex CLI',
              score: 88,
              latency: '12.4ms',
              memory: '420 MB',
              pros: ['Near-perfect recall (99.4%)', 'Exact nearest neighbors'],
              cons: ['High memory footprint (420 MB)', 'Slower indexing build time'],
              selected: false,
            },
            {
              id: 'cand-b',
              name: 'Candidate B (Quantized IVF)',
              runtime: 'Claude Code',
              score: 96,
              latency: '3.8ms',
              memory: '95 MB',
              pros: ['3.2x faster query throughput', '77% less RAM consumption', 'Fast centroid clustering'],
              cons: ['Approximate recall (95.2%)'],
              selected: true,
            },
          ],
        },
      },
      {
        id: 'cand-ev-7',
        type: 'file_change',
        agentRole: 'reviewer',
        content: 'Merged winning Candidate B (`feat/ivf-pq`) into main branch.',
        timestamp: '18:30:21',
        diffData: {
          path: 'src/index/quantized_ivf.rs',
          status: 'added',
          additions: 128,
          deletions: 0,
          diffSnippet: `+pub struct QuantizedIvfIndex {
+    centroids: Vec<Centroid>,
+    quantizer: ProductQuantizer,
+    inverted_lists: Vec<Vec<PostingEntry>>,
+}
+
+impl QuantizedIvfIndex {
+    pub fn search(&self, query: &[f32], nprobe: usize) -> Vec<SearchResult> {
+        let coarse_centroids = self.find_nearest_centroids(query, nprobe);
+        let mut heap = BinaryHeap::with_capacity(10);
+        for centroid_id in coarse_centroids {
+            for entry in &self.inverted_lists[centroid_id] {
+                let dist = self.quantizer.asymmetric_distance(query, &entry.code);
+                heap.push(SearchResult { id: entry.doc_id, distance: dist });
+            }
+        }
+        heap.into_sorted_vec()
+    }
+}`,
        },
      },
      {
        id: 'cand-ev-8',
        type: 'qa_check',
        agentRole: 'qa',
        content: 'Verification check: 1M vector search regression suite passed.',
        timestamp: '18:30:24',
        checkData: {
          id: 'qa-check-cand',
          name: 'Vector Index Recall & Memory Regression',
          passed: true,
          summary: 'Recall: 95.2%, QPS: 2,630 queries/sec, Peak RSS: 95 MB.',
          timestamp: '18:30:24',
          category: 'performance',
        },
      },
      {
        id: 'cand-ev-9',
        type: 'mission_summary',
        agentRole: 'orchestrator',
        content: 'Candidate evaluation concluded. Worktree merge executed with verified 3.2x performance boost.',
        timestamp: '18:30:27',
        tokens: 3840,
      },
    ],
    finalDiffs: [
      {
        path: 'src/index/quantized_ivf.rs',
        status: 'added',
        additions: 128,
        deletions: 0,
        diffSnippet: `+pub struct QuantizedIvfIndex {
+    centroids: Vec<Centroid>,
+    quantizer: ProductQuantizer,
+    inverted_lists: Vec<Vec<PostingEntry>>,
+}
+
+impl QuantizedIvfIndex {
+    pub fn search(&self, query: &[f32], nprobe: usize) -> Vec<SearchResult> {
+        let coarse_centroids = self.find_nearest_centroids(query, nprobe);
+        let mut heap = BinaryHeap::with_capacity(10);
+        for centroid_id in coarse_centroids {
+            for entry in &self.inverted_lists[centroid_id] {
+                let dist = self.quantizer.asymmetric_distance(query, &entry.code);
+                heap.push(SearchResult { id: entry.doc_id, distance: dist });
+            }
+        }
+        heap.into_sorted_vec()
+    }
+}`,
      },
    ],
    qaChecks: [
      {
        id: 'check-cand-1',
        name: 'Benchmark Throughput (QPS & Latency p99)',
        passed: true,
        summary: '2,630 QPS at 3.8ms p99 latency on 1M embeddings.',
        timestamp: '18:30:23',
        category: 'performance',
      },
      {
        id: 'check-cand-2',
        name: 'Memory Budget Compliance (< 150 MB)',
        passed: true,
        summary: 'Peak memory usage: 95 MB (well under 150 MB ceiling).',
        timestamp: '18:30:24',
        category: 'performance',
      },
    ],
  },
];
