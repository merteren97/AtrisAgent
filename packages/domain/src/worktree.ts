export interface Worktree {
  id: string;
  missionId: string;
  taskId: string;
  branchName: string;
  path: string;
  status: 'active' | 'merged' | 'abandoned';
  createdAt: string;
}

export interface Branch {
  name: string;
  worktreeId: string;
  baseBranch: string;
  createdAt: string;
}
