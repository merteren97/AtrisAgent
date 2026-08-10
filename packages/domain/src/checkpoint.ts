export interface Checkpoint {
  id: string;
  missionId: string;
  workspaceId: string;
  label: string;
  gitRef: string | null;
  snapshotPath: string | null;
  createdAt: string;
  isRollbackTarget: boolean;
}
