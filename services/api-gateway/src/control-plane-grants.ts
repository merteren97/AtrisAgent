import { createHash, randomBytes } from 'crypto';
import type { AgentRole } from '@atris-agent-code/domain';

export interface ControlPlaneGrantContext {
  agentInstanceId: string;
  missionId: string;
  taskId: string;
  role: AgentRole | string;
}

export interface ControlPlaneGrant extends ControlPlaneGrantContext {
  issuedAt: string;
  expiresAt: string;
}

export interface IssuedControlPlaneGrant {
  token: string;
  expiresAt: string;
}

interface StoredGrant extends ControlPlaneGrant {
  requestWindowStartedAt: number;
  requestsInWindow: number;
}

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const REQUEST_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 240;

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Ephemeral, session-scoped capability tokens for native CLI agents.
 *
 * Raw bearer tokens are never persisted and are never kept in this registry. The
 * server stores only their SHA-256 digest plus the identity that the token is
 * allowed to represent. Every control-plane call therefore gets its mission,
 * task, role and agent identity from the server-side grant rather than trusting
 * model-provided arguments.
 */
export class ControlPlaneGrantRegistry {
  private readonly grants = new Map<string, StoredGrant>();

  issue(context: ControlPlaneGrantContext, ttlMs = DEFAULT_TTL_MS): IssuedControlPlaneGrant {
    this.pruneExpired();
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAtMs = now + Math.max(60_000, ttlMs);
    this.grants.set(digest(token), {
      ...context,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      requestWindowStartedAt: now,
      requestsInWindow: 0,
    });
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  authorize(authorizationHeader?: string): ControlPlaneGrant | null {
    const match = authorizationHeader?.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) return null;

    const key = digest(match[1].trim());
    const grant = this.grants.get(key);
    if (!grant) return null;

    const now = Date.now();
    if (Date.parse(grant.expiresAt) <= now) {
      this.grants.delete(key);
      return null;
    }

    if (now - grant.requestWindowStartedAt >= REQUEST_WINDOW_MS) {
      grant.requestWindowStartedAt = now;
      grant.requestsInWindow = 0;
    }
    grant.requestsInWindow += 1;
    if (grant.requestsInWindow > MAX_REQUESTS_PER_WINDOW) {
      throw new Error('Control-plane rate limit exceeded for this agent session.');
    }

    return {
      agentInstanceId: grant.agentInstanceId,
      missionId: grant.missionId,
      taskId: grant.taskId,
      role: grant.role,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    };
  }

  revokeAgent(agentInstanceId: string): void {
    for (const [key, grant] of this.grants.entries()) {
      if (grant.agentInstanceId === agentInstanceId) this.grants.delete(key);
    }
  }

  revokeMission(missionId: string): void {
    for (const [key, grant] of this.grants.entries()) {
      if (grant.missionId === missionId) this.grants.delete(key);
    }
  }

  clear(): void {
    this.grants.clear();
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, grant] of this.grants.entries()) {
      if (Date.parse(grant.expiresAt) <= now) this.grants.delete(key);
    }
  }
}
