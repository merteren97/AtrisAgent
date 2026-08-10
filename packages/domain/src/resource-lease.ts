export interface ResourceLease {
  id: string;
  resourceType: string;
  resourceId: string;
  heldByAgentId: string;
  expiresAt: string;
  heartbeatAt: string;
  status?: 'active' | 'expired' | 'released';
  metadata?: Record<string, unknown> | null;
}
