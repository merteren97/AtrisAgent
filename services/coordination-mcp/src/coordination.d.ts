export declare class CoordinationMCP {
    getWorkspaceContext(workspacePath?: string, missionId?: string, taskId?: string): Promise<unknown>;
    getActivePlan(missionId: string): Promise<unknown>;
    claimTask(taskId: string, agentId: string): Promise<void>;
    reportProgress(taskId: string, progress: string): Promise<void>;
    submitResult(taskId: string, result: unknown): Promise<void>;
    requestApproval(approvalRequest: unknown): Promise<string>;
    getAgentActivity(agentId: string): Promise<unknown>;
    reserveResource(resourceType: string, agentId: string): Promise<string>;
    releaseResource(leaseId: string): Promise<void>;
    getChangedFiles(worktreePath: string): Promise<unknown[]>;
    publishArtifact(artifact: unknown): Promise<string>;
}
//# sourceMappingURL=coordination.d.ts.map
