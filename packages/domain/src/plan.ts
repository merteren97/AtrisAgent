export interface Plan {
  id: string;
  missionId: string;
  version: number;
  summary: string;
  tasks: string[]; // task IDs in order
  status: 'draft' | 'approved' | 'executing' | 'completed' | 'revised';
  createdAt: string;
  approvedAt: string | null;
}
