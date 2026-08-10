import type { ExecutionMode } from './mission';

export interface PolicyProfile {
  id: string;
  name: string;
  executionMode: ExecutionMode;
  planApproval: 'always' | 'risk_based' | 'never';
  fileWrite: 'ask' | 'automatic';
  gitCommit: 'ask' | 'automatic';
  applyToWorkspace: 'user_decides' | 'orchestrator_decides' | 'automatic';
  packageInstall: 'ask' | 'allowlisted' | 'automatic';
  databaseMigration: 'ask' | 'automatic';
  gitPush: 'never' | 'ask' | 'automatic';
  pullRequest: 'ask' | 'automatic';
  deleteFiles: 'ask' | 'risk_based' | 'automatic';
}

export interface CustomPolicyMatrix {
  fileAccessAllowlist: string[];
  fileAccessBlocklist: string[];
  commandPrefixAllowlist: string[];
  commandPrefixBlocklist: string[];
  allowedNetworkHosts: string[];
  secretRedactionPatterns: string[];
  maxExecutionTimeSeconds: number;
  maxCostPerTaskUsd: number;
}
