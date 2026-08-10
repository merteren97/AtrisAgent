export class CoordinationMCP {
    async getWorkspaceContext(workspacePath) {
        throw new Error('Not implemented');
    }
    async getActivePlan(missionId) {
        throw new Error('Not implemented');
    }
    async claimTask(taskId, agentId) {
        throw new Error('Not implemented');
    }
    async reportProgress(taskId, progress) {
        throw new Error('Not implemented');
    }
    async submitResult(taskId, result) {
        throw new Error('Not implemented');
    }
    async requestApproval(approvalRequest) {
        throw new Error('Not implemented');
    }
    async getAgentActivity(agentId) {
        throw new Error('Not implemented');
    }
    async reserveResource(resourceType, agentId) {
        throw new Error('Not implemented');
    }
    async releaseResource(leaseId) {
        throw new Error('Not implemented');
    }
    async getChangedFiles(worktreePath) {
        throw new Error('Not implemented');
    }
    async publishArtifact(artifact) {
        throw new Error('Not implemented');
    }
}
//# sourceMappingURL=coordination.js.map