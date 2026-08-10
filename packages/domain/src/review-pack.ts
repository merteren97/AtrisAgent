export interface ReviewPack {
  taskId: string;
  taskSpecification: string;
  builderSummary: string;
  changedFiles: ChangedFile[];
  unifiedDiff: string;
  buildResult: CheckResult | null;
  testResult: CheckResult | null;
  lintResult: CheckResult | null;
  newDependencies: string[];
  riskyOperations: string[];
  artifacts: string[]; // artifact IDs
  reviewerFindings: string | null;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  summary: string;
  output: string | null;
}
