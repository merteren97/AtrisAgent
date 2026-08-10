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
