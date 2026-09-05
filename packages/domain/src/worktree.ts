export interface Worktree {
  id: string;
  missionId: string;
  taskId: string;
  branchName: string;
  path: string;
  status: 'active' | 'merged' | 'abandoned';
  isolationKind?: 'workspace-git' | 'nested-git' | 'mirror' | 'new-sibling';
  canonicalContainer?: string | null;
  targetName?: string | null;
  targetPath?: string | null;
  appliedOperationKey?: string | null;
  targetDescriptor?: import('./task').BuilderTargetDescriptor | null;
  createdAt: string;
}

export interface Branch {
  name: string;
  worktreeId: string;
  baseBranch: string;
  createdAt: string;
}
