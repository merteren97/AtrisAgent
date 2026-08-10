import { resourceLeases, type AtrisDatabase } from '@atris-agent-code/database';
import { eq } from 'drizzle-orm';

export interface LeaseInfo {
  id: string;
  resourceType: string;
  resourceId: string;
  heldByAgentId: string;
  expiresAt: string;
  heartbeatAt: string;
  status: 'active' | 'expired' | 'released';
  metadata?: Record<string, unknown>;
}

export class ResourceLeaseManager {
  private inMemoryLeases: Map<string, LeaseInfo> = new Map();

  async reserveLease(
    resourceType: string,
    heldByAgentId: string,
    resourceId?: string,
    ttlSeconds: number = 300,
    metadata?: Record<string, unknown>,
    db?: AtrisDatabase
  ): Promise<{ leaseId: string; expiresAt: string }> {
    await this.cleanupExpiredLeases(db);

    const effectiveResourceId = resourceId || resourceType;
    const now = new Date();
    const expiresAtDate = new Date(now.getTime() + ttlSeconds * 1000);
    const expiresAtStr = expiresAtDate.toISOString();
    const heartbeatAtStr = now.toISOString();

    // Check existing active lease
    for (const lease of this.inMemoryLeases.values()) {
      if (
        lease.resourceType === resourceType &&
        lease.resourceId === effectiveResourceId &&
        lease.status === 'active'
      ) {
        if (lease.heldByAgentId !== heldByAgentId) {
          throw new Error(
            `Resource "${resourceType}" (${effectiveResourceId}) is locked by agent "${lease.heldByAgentId}" until ${lease.expiresAt}`
          );
        }
      }
    }

    const leaseId = crypto.randomUUID();
    const newLease: LeaseInfo = {
      id: leaseId,
      resourceType,
      resourceId: effectiveResourceId,
      heldByAgentId,
      expiresAt: expiresAtStr,
      heartbeatAt: heartbeatAtStr,
      status: 'active',
      metadata,
    };

    this.inMemoryLeases.set(leaseId, newLease);

    if (db) {
      try {
        await db.insert(resourceLeases).values({
          id: leaseId,
          resourceType,
          resourceId: effectiveResourceId,
          heldByAgentId,
          expiresAt: expiresAtStr,
          heartbeatAt: heartbeatAtStr,
          status: 'active',
          metadata: metadata || null,
        });
      } catch {
        // Ignore DB insert failure if in-memory active
      }
    }

    return { leaseId, expiresAt: expiresAtStr };
  }

  async heartbeatLease(
    leaseId: string,
    ttlSeconds: number = 300,
    db?: AtrisDatabase
  ): Promise<{ expiresAt: string }> {
    const lease = this.inMemoryLeases.get(leaseId);
    if (!lease || lease.status !== 'active') {
      throw new Error(`Active lease "${leaseId}" not found for heartbeat`);
    }

    const now = new Date();
    const expiresAtDate = new Date(now.getTime() + ttlSeconds * 1000);
    const expiresAtStr = expiresAtDate.toISOString();
    const heartbeatAtStr = now.toISOString();

    lease.expiresAt = expiresAtStr;
    lease.heartbeatAt = heartbeatAtStr;

    if (db) {
      await db
        .update(resourceLeases)
        .set({ expiresAt: expiresAtStr, heartbeatAt: heartbeatAtStr })
        .where(eq(resourceLeases.id, leaseId));
    }

    return { expiresAt: expiresAtStr };
  }

  async releaseLease(leaseId: string, db?: AtrisDatabase): Promise<void> {
    const lease = this.inMemoryLeases.get(leaseId);
    if (lease) {
      lease.status = 'released';
      this.inMemoryLeases.delete(leaseId);
    }

    if (db) {
      await db
        .update(resourceLeases)
        .set({ status: 'released' })
        .where(eq(resourceLeases.id, leaseId));
    }
  }

  async cleanupExpiredLeases(db?: AtrisDatabase): Promise<number> {
    const nowIso = new Date().toISOString();
    let cleaned = 0;

    for (const [id, lease] of this.inMemoryLeases.entries()) {
      if (lease.expiresAt < nowIso) {
        lease.status = 'expired';
        this.inMemoryLeases.delete(id);
        cleaned++;
      }
    }

    if (db) {
      try {
        await db
          .update(resourceLeases)
          .set({ status: 'expired' })
          .where(eq(resourceLeases.status, 'active'));
      } catch {
        // Ignore DB update errors
      }
    }

    return cleaned;
  }
}
