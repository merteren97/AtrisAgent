import { resourceLeases, type AtrisDatabase, type ResourceLeaseSelect } from '@atris-agent-code/database';
import { and, eq, gt, lt } from 'drizzle-orm';

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

function effectiveTtlSeconds(value: number): number {
  if (!Number.isFinite(value)) return 300;
  return Math.max(1, Math.floor(value));
}

function toLeaseInfo(row: ResourceLeaseSelect): LeaseInfo {
  return {
    id: row.id,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    heldByAgentId: row.heldByAgentId,
    expiresAt: row.expiresAt,
    heartbeatAt: row.heartbeatAt,
    status: row.status === 'expired' || row.status === 'released' ? row.status : 'active',
    metadata: row.metadata || undefined,
  };
}

function leaseConflict(lease: LeaseInfo): Error {
  return new Error(
    `Resource "${lease.resourceType}" (${lease.resourceId}) is locked by agent "${lease.heldByAgentId}" until ${lease.expiresAt}`,
  );
}

export class ResourceLeaseManager {
  private inMemoryLeases: Map<string, LeaseInfo> = new Map();

  async reserveLease(
    resourceType: string,
    heldByAgentId: string,
    resourceId?: string,
    ttlSeconds: number = 300,
    metadata?: Record<string, unknown>,
    db?: AtrisDatabase,
  ): Promise<{ leaseId: string; expiresAt: string }> {
    const effectiveResourceId = resourceId || resourceType;
    const ttl = effectiveTtlSeconds(ttlSeconds);
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAtStr = new Date(now.getTime() + ttl * 1000).toISOString();
    const heartbeatAtStr = nowIso;

    if (db) {
      await this.cleanupExpiredLeases(db);
      const activeRows = await db.select().from(resourceLeases).where(and(
        eq(resourceLeases.resourceType, resourceType),
        eq(resourceLeases.resourceId, effectiveResourceId),
        eq(resourceLeases.status, 'active'),
        gt(resourceLeases.expiresAt, nowIso),
      ));
      const existing = activeRows[0];
      if (existing) {
        const existingLease = toLeaseInfo(existing);
        if (existingLease.heldByAgentId !== heldByAgentId) throw leaseConflict(existingLease);
        this.inMemoryLeases.set(existingLease.id, existingLease);
        return { leaseId: existingLease.id, expiresAt: existingLease.expiresAt };
      }

      const leaseId = crypto.randomUUID();
      // The partial unique index makes this insert the cross-process claim.
      // Do not fall back to memory if persistence fails: that would create a
      // lease visible only to one gateway and allow a concurrent owner.
      await db.insert(resourceLeases).values({
        id: leaseId,
        resourceType,
        resourceId: effectiveResourceId,
        heldByAgentId,
        expiresAt: expiresAtStr,
        heartbeatAt: heartbeatAtStr,
        status: 'active',
        metadata: metadata || null,
      }).onConflictDoNothing();

      const insertedRows = await db.select().from(resourceLeases).where(eq(resourceLeases.id, leaseId));
      if (insertedRows[0]) {
        const inserted = toLeaseInfo(insertedRows[0]);
        this.inMemoryLeases.set(inserted.id, inserted);
        return { leaseId: inserted.id, expiresAt: inserted.expiresAt };
      }

      const winnerRows = await db.select().from(resourceLeases).where(and(
        eq(resourceLeases.resourceType, resourceType),
        eq(resourceLeases.resourceId, effectiveResourceId),
        eq(resourceLeases.status, 'active'),
        gt(resourceLeases.expiresAt, nowIso),
      ));
      if (winnerRows[0]) throw leaseConflict(toLeaseInfo(winnerRows[0]));
      throw new Error(`Resource lease for "${resourceType}" (${effectiveResourceId}) could not be persisted.`);
    }

    for (const lease of this.inMemoryLeases.values()) {
      if (lease.resourceType !== resourceType || lease.resourceId !== effectiveResourceId || lease.status !== 'active') continue;
      if (lease.expiresAt <= nowIso) {
        lease.status = 'expired';
        this.inMemoryLeases.delete(lease.id);
        continue;
      }
      if (lease.heldByAgentId !== heldByAgentId) throw leaseConflict(lease);
      return { leaseId: lease.id, expiresAt: lease.expiresAt };
    }

    const leaseId = crypto.randomUUID();
    this.inMemoryLeases.set(leaseId, {
      id: leaseId,
      resourceType,
      resourceId: effectiveResourceId,
      heldByAgentId,
      expiresAt: expiresAtStr,
      heartbeatAt: heartbeatAtStr,
      status: 'active',
      metadata,
    });
    return { leaseId, expiresAt: expiresAtStr };
  }

  async heartbeatLease(
    leaseId: string,
    ttlSeconds: number = 300,
    db?: AtrisDatabase,
  ): Promise<{ expiresAt: string }> {
    const ttl = effectiveTtlSeconds(ttlSeconds);
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAtStr = new Date(now.getTime() + ttl * 1000).toISOString();
    const heartbeatAtStr = nowIso;

    if (db) {
      await this.cleanupExpiredLeases(db);
      const result = await db.update(resourceLeases)
        .set({ expiresAt: expiresAtStr, heartbeatAt: heartbeatAtStr })
        .where(and(
          eq(resourceLeases.id, leaseId),
          eq(resourceLeases.status, 'active'),
          gt(resourceLeases.expiresAt, nowIso),
        ));
      if (Number((result as { changes?: number }).changes || 0) !== 1) {
        this.inMemoryLeases.delete(leaseId);
        throw new Error(`Active lease "${leaseId}" not found for heartbeat`);
      }
      const existing = this.inMemoryLeases.get(leaseId);
      if (existing) {
        existing.expiresAt = expiresAtStr;
        existing.heartbeatAt = heartbeatAtStr;
      }
      return { expiresAt: expiresAtStr };
    }

    const lease = this.inMemoryLeases.get(leaseId);
    if (!lease || lease.status !== 'active' || lease.expiresAt <= nowIso) {
      if (lease) this.inMemoryLeases.delete(leaseId);
      throw new Error(`Active lease "${leaseId}" not found for heartbeat`);
    }
    lease.expiresAt = expiresAtStr;
    lease.heartbeatAt = heartbeatAtStr;
    return { expiresAt: expiresAtStr };
  }

  async releaseLease(leaseId: string, db?: AtrisDatabase): Promise<void> {
    if (db) {
      await db.update(resourceLeases)
        .set({ status: 'released' })
        .where(and(eq(resourceLeases.id, leaseId), eq(resourceLeases.status, 'active')));
    }
    const lease = this.inMemoryLeases.get(leaseId);
    if (lease) {
      lease.status = 'released';
      this.inMemoryLeases.delete(leaseId);
    }
  }

  async cleanupExpiredLeases(db?: AtrisDatabase): Promise<number> {
    const nowIso = new Date().toISOString();
    if (db) {
      const expiredRows = await db.select().from(resourceLeases).where(and(
        eq(resourceLeases.status, 'active'),
        lt(resourceLeases.expiresAt, nowIso),
      ));
      if (expiredRows.length === 0) return 0;
      await db.update(resourceLeases)
        .set({ status: 'expired' })
        .where(and(eq(resourceLeases.status, 'active'), lt(resourceLeases.expiresAt, nowIso)));
      for (const row of expiredRows) this.inMemoryLeases.delete(row.id);
      return expiredRows.length;
    }

    let cleaned = 0;
    for (const [id, lease] of this.inMemoryLeases.entries()) {
      if (lease.expiresAt < nowIso) {
        lease.status = 'expired';
        this.inMemoryLeases.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }
}
