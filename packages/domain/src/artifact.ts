export type ArtifactType =
  | 'code'
  | 'report'
  | 'test_output'
  | 'test_report'
  | 'visual'
  | 'file'
  | 'diff'
  | 'log'
  | 'review_pack'
  | 'build_output'
  | 'plan'
  | 'decision'
  | 'research'
  | 'verification'
  | 'release_summary';

export interface Artifact {
  id: string;
  runId: string;
  taskId: string;
  missionId: string;
  type: ArtifactType;
  name: string;
  path: string | null;
  content: string | null;
  createdAt: string;
}

export interface ResearchContextSource {
  taskId: string;
  attemptId?: string;
  result: string;
  uncertain: boolean;
}

export interface ResearchContextBundle {
  version: 1;
  missionId: string;
  planId: string;
  sourceTaskIds: string[];
  sources: ResearchContextSource[];
  conflicts: string[];
  truncated: boolean;
}
