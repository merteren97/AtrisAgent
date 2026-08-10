export interface UsageRecord {
  id: string;
  missionId: string;
  agentInstanceId: string;
  accountProfileId: string;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  currency: string;
  recordedAt: string;
}
