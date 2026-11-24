import assert from 'node:assert/strict';
import express, { type Request } from 'express';
import type { AddressInfo } from 'node:net';
import type { UsageLimitsResponse } from './activity-types';
import { isLocalDataRequest } from './local-data-access';
import { installUsageLimitsRoutes } from './usage-limits-routes';
import {
  OPENCODE_USAGE_LIMITS_NOTE,
  UsageLimitsService,
  parseAntigravityUsageOutput,
  parseClaudeUsagePayload,
  parseCodexRateLimits,
} from './usage-limits-service';

async function runTests(): Promise<void> {
  // 1. Antigravity JSON parsing: 2 groups x 2 buckets, weekly-before-5h input sorted to 5h-before-weekly
  {
    const sampleJson = JSON.stringify({
      command: {
        data: {
          groups: [
            {
              name: 'Gemini Models',
              description: 'Gemini 2.5 Pro and Flash',
              buckets: [
                {
                  id: 'gemini-weekly',
                  name: 'Weekly',
                  description: 'Shared weekly quota',
                  window: 'weekly',
                  remaining_fraction: 0.724,
                  reset_time: '2026-11-30T20:20:24Z',
                },
                {
                  id: 'gemini-5h',
                  name: '5-Hour',
                  description: 'Rolling 5-hour quota',
                  window: '5h',
                  remaining_fraction: 0.9,
                  reset_time: '2026-11-24T18:00:00Z',
                },
              ],
            },
            {
              name: 'Claude and GPT models',
              description: 'Third-party frontier models',
              buckets: [
                {
                  id: 'claude-5h',
                  name: '5-Hour',
                  description: '',
                  window: '5h',
                  remaining_fraction: 0.4,
                  reset_time: '2026-11-24T17:30:00Z',
                },
                {
                  id: 'claude-weekly',
                  name: 'Weekly',
                  description: '',
                  window: 'weekly',
                  remaining_fraction: 1.0,
                  reset_time: '2026-12-01T00:00:00Z',
                },
              ],
            },
          ],
        },
      },
    });

    const parsed = parseAntigravityUsageOutput(sampleJson, '', 0, '2026-11-24T12:00:00.000Z');
    assert.equal(parsed.provider, 'antigravity');
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.windows.length, 4);

    // Group 1 ordered: 5h before weekly
    assert.equal(parsed.windows[0].id, 'gemini-5h');
    assert.equal(parsed.windows[0].windowKind, 'five_hour');
    assert.equal(parsed.windows[0].label, '5-Hour Limit');
    assert.equal(parsed.windows[0].group, 'Gemini Models');
    assert.equal(parsed.windows[0].remainingPercent, 90);
    assert.equal(parsed.windows[0].usedPercent, 10);
    assert.equal(parsed.windows[0].windowDurationMins, 300);

    assert.equal(parsed.windows[1].id, 'gemini-weekly');
    assert.equal(parsed.windows[1].windowKind, 'weekly');
    assert.equal(parsed.windows[1].remainingPercent, 72);
    assert.equal(parsed.windows[1].usedPercent, 28);
    assert.equal(parsed.windows[1].windowDurationMins, 10080);

    // Group 2
    assert.equal(parsed.windows[2].id, 'claude-5h');
    assert.equal(parsed.windows[2].remainingPercent, 40);
    assert.equal(parsed.windows[2].usedPercent, 60);
    assert.equal(parsed.windows[3].id, 'claude-weekly');
    assert.equal(parsed.windows[3].remainingPercent, 100);
    assert.equal(parsed.windows[3].usedPercent, 0);
  }

  // 2. Antigravity text fallback, unauthenticated, and missing binary
  {
    const tsv = [
      'Gemini Models\tWeekly Limit\t85%\t2026-11-30T20:20:24Z',
      'Gemini Models\t5h Limit\t95%\t2026-11-24T18:00:00Z',
    ].join('\n');
    const parsedTsv = parseAntigravityUsageOutput(tsv);
    assert.equal(parsedTsv.status, 'ok');
    assert.equal(parsedTsv.windows.length, 2);
    assert.equal(parsedTsv.windows[0].windowKind, 'five_hour');
    assert.equal(parsedTsv.windows[0].remainingPercent, 95);
    assert.equal(parsedTsv.windows[0].usedPercent, 5);
    assert.equal(parsedTsv.windows[1].windowKind, 'weekly');
    assert.equal(parsedTsv.windows[1].remainingPercent, 85);

    const unauth = parseAntigravityUsageOutput('', 'Not signed in. Please login.', 1);
    assert.equal(unauth.status, 'unauthenticated');

    const missingService = new UsageLimitsService({
      findAntigravityExecutable: () => null,
      findCodexExecutable: () => null,
      findClaudeExecutable: () => null,
    });
    const missingRes = await missingService.getUsageLimits();
    assert.equal(missingRes.providers[0].status, 'unavailable');
    assert.match(missingRes.providers[0].message || '', /not installed/i);
    assert.equal(missingRes.providers[1].status, 'unavailable');
    assert.match(missingRes.providers[1].message || '', /not installed/i);
    assert.equal(missingRes.providers[2].status, 'unavailable');
    assert.match(missingRes.providers[2].message || '', /not installed/i);
    assert.equal(missingRes.opencodeNote, OPENCODE_USAGE_LIMITS_NOTE);
  }

  // 3. Codex JSON-RPC parsing + API-key null rateLimits
  {
    const parsedCodex = parseCodexRateLimits({
      rateLimits: {
        planType: 'plus',
        primary: { usedPercent: 24.6, windowDurationMins: 300, resetsAt: 1795536000 },
        secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1796054400 },
      },
    });
    assert.equal(parsedCodex.status, 'ok');
    assert.equal(parsedCodex.planLabel, 'Plus');
    assert.equal(parsedCodex.windows.length, 2);
    assert.equal(parsedCodex.windows[0].windowKind, 'five_hour');
    assert.equal(parsedCodex.windows[0].usedPercent, 25);
    assert.equal(parsedCodex.windows[0].remainingPercent, 75);
    assert.equal(parsedCodex.windows[0].resetsAt, new Date(1795536000 * 1000).toISOString());
    assert.equal(parsedCodex.windows[1].windowKind, 'weekly');
    assert.equal(parsedCodex.windows[1].usedPercent, 61);
    assert.equal(parsedCodex.windows[1].remainingPercent, 39);

    const apiKeyCodex = parseCodexRateLimits({ rateLimits: null });
    assert.equal(apiKeyCodex.status, 'unavailable');
    assert.match(apiKeyCodex.message || '', /API key mode/i);
  }

  // 4. Claude Code parsing + logged out + OAuth + 429 cooldown + secret redaction
  {
    const parsedClaude = parseClaudeUsagePayload({
      five_hour: { utilization: 42.5, resets_at: '2026-11-24T17:00:00Z' },
      seven_day: { utilization: 18.2, resets_at: '2026-11-30T00:00:00Z' },
      seven_day_sonnet: { utilization: 9.0, resets_at: '2026-11-30T00:00:00Z' },
      seven_day_opus: null,
    });
    assert.equal(parsedClaude.status, 'ok');
    assert.equal(parsedClaude.windows.length, 3);
    assert.equal(parsedClaude.windows[0].usedPercent, 43);
    assert.equal(parsedClaude.windows[0].remainingPercent, 57);
    assert.equal(parsedClaude.windows[1].id, 'seven_day');
    assert.equal(parsedClaude.windows[2].id, 'seven_day_sonnet');

    // Logged out
    const loggedOutSvc = new UsageLimitsService({
      findAntigravityExecutable: () => null,
      findCodexExecutable: () => null,
      findClaudeExecutable: () => '/usr/local/bin/claude',
      runCli: async () => ({
        stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
        stderr: '',
        exitCode: 0,
      }),
    });
    const loggedOutRes = await loggedOutSvc.getUsageLimits();
    assert.equal(loggedOutRes.providers[2].status, 'unauthenticated');

    // 429 cooldown + secret redaction on subsequent error
    let nowMs = 1_000_000;
    let fetchCalls = 0;
    let fetchMode: 'ok' | '429' | 'error_with_secret' = '429';
    const secretToken = 'sk-ant-oat01-SUPERSECRETTOKENVALUE12345';

    const claudeSvc = new UsageLimitsService({
      now: () => nowMs,
      cacheTtlMs: 60_000,
      rateLimitCooldownMs: 120_000,
      refreshDebounceMs: 5_000,
      findAntigravityExecutable: () => null,
      findCodexExecutable: () => null,
      findClaudeExecutable: () => '/usr/local/bin/claude',
      runCli: async () => ({
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
        stderr: '',
        exitCode: 0,
      }),
      readClaudeCredentials: async () => secretToken,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        fetchCalls++;
        assert.equal((init?.headers as Record<string, string>)?.Authorization, `Bearer ${secretToken}`);
        if (fetchMode === '429') {
          return new Response('rate limited', { status: 429 });
        }
        if (fetchMode === 'error_with_secret') {
          throw new Error(`Upstream failed with Bearer ${secretToken}`);
        }
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 10, resets_at: '2026-11-24T17:00:00Z' },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    const first429 = await claudeSvc.getUsageLimits({ refresh: true });
    assert.equal(first429.providers[2].status, 'rate_limited');
    assert.equal(fetchCalls, 1);

    // Even with refresh=true 10s later, 429 cooldown prevents hitting Anthropic API again
    nowMs += 10_000;
    const cooledDown = await claudeSvc.getUsageLimits({ refresh: true });
    assert.equal(cooledDown.providers[2].status, 'rate_limited');
    assert.equal(fetchCalls, 1, 'must not call Anthropic API during 120s cooldown');

    // After cooldown expires (125s), next refresh hits API and succeeds
    nowMs += 115_000;
    fetchMode = 'ok';
    const recovered = await claudeSvc.getUsageLimits({ refresh: true });
    assert.equal(recovered.providers[2].status, 'ok');
    assert.equal(fetchCalls, 2);

    // Next refresh fails with secret in error -> stale fallback + secret redacted
    nowMs += 10_000;
    fetchMode = 'error_with_secret';
    const staleRes = await claudeSvc.getUsageLimits({ refresh: true });
    assert.equal(staleRes.providers[2].status, 'ok');
    assert.equal(staleRes.providers[2].stale, true);
    assert.ok(!JSON.stringify(staleRes).includes(secretToken), 'secret token must never appear in response');
    assert.match(staleRes.providers[2].message || '', /\[REDACTED\]/);
  }

  // 5. TTL cache hit, ?refresh=1 bypass, and timeout isolation
  {
    let nowMs = 5_000_000;
    let agyCalls = 0;
    const svc = new UsageLimitsService({
      now: () => nowMs,
      cacheTtlMs: 60_000,
      refreshDebounceMs: 5_000,
      timeoutsMs: { antigravity: 200, codex: 80, claude_code: 200 },
      findAntigravityExecutable: () => '/usr/bin/agy',
      findCodexExecutable: () => '/usr/bin/codex',
      findClaudeExecutable: () => null,
      runCli: async () => {
        agyCalls++;
        return {
          stdout: JSON.stringify({
            command: {
              data: {
                groups: [
                  {
                    name: 'Gemini',
                    buckets: [{ id: 'g5h', name: '5h', window: '5h', remaining_fraction: 0.8 }],
                  },
                ],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      },
      queryCodexRateLimits: () => new Promise(() => {}), // hangs forever -> times out at 80ms
    });

    const r1 = await svc.getUsageLimits();
    assert.equal(r1.cached, false);
    assert.equal(r1.providers[0].status, 'ok');
    assert.equal(r1.providers[1].status, 'error');
    assert.match(r1.providers[1].message || '', /timed out/i);
    assert.equal(agyCalls, 1);

    // Within 60s TTL -> cached: true, no new CLI call
    nowMs += 10_000;
    const r2 = await svc.getUsageLimits();
    assert.equal(r2.cached, true);
    assert.equal(agyCalls, 1);

    // refresh=true bypasses TTL cache after 5s debounce
    const r3 = await svc.getUsageLimits({ refresh: true });
    assert.equal(r3.cached, false);
    assert.equal(agyCalls, 2);
  }

  // 6. HTTP route test GET /api/insights/usage-limits + isLocalDataRequest allowlist
  {
    const mockService = new UsageLimitsService({
      findAntigravityExecutable: () => null,
      findCodexExecutable: () => null,
      findClaudeExecutable: () => null,
    });
    const app = express();
    installUsageLimitsRoutes(app, mockService);

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const res = await fetch(`${baseUrl}/api/insights/usage-limits?refresh=1`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as UsageLimitsResponse;
      assert.equal(body.providers.length, 3);
      assert.equal(body.opencodeNote, OPENCODE_USAGE_LIMITS_NOTE);

      const allowedReq = {
        method: 'GET',
        originalUrl: '/api/insights/usage-limits?refresh=1',
        url: '/api/insights/usage-limits?refresh=1',
        headers: { 'x-atris-runtime-token': 'tok-123' },
      } as unknown as Request;
      assert.equal(isLocalDataRequest(allowedReq, 'tok-123'), true);
      assert.equal(isLocalDataRequest(allowedReq, 'wrong-tok'), false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }

  console.log('Usage limits service tests passed.');
}

runTests().catch((error) => {
  console.error('Usage limits service test failed:', error);
  process.exit(1);
});
