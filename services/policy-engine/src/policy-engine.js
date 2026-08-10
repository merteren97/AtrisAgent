export class PolicyEngine {
    config;
    constructor(mode) {
        this.config = PolicyEngine.getDefaultConfig(mode);
    }
    static getDefaultConfig(mode) {
        switch (mode) {
            case 'review_driven':
                return {
                    executionMode: 'review_driven',
                    planApproval: 'always',
                    fileWrite: 'ask',
                    gitCommit: 'ask',
                    applyToWorkspace: 'user_decides',
                    packageInstall: 'ask',
                    databaseMigration: 'ask',
                    gitPush: 'ask',
                    pullRequest: 'ask',
                    deleteFiles: 'ask',
                };
            case 'balanced':
                return {
                    executionMode: 'balanced',
                    planApproval: 'risk_based',
                    fileWrite: 'automatic',
                    gitCommit: 'automatic',
                    applyToWorkspace: 'orchestrator_decides',
                    packageInstall: 'allowlisted',
                    databaseMigration: 'ask',
                    gitPush: 'ask',
                    pullRequest: 'ask',
                    deleteFiles: 'risk_based',
                };
            case 'autonomous':
                return {
                    executionMode: 'autonomous',
                    planApproval: 'never',
                    fileWrite: 'automatic',
                    gitCommit: 'automatic',
                    applyToWorkspace: 'automatic',
                    packageInstall: 'automatic',
                    databaseMigration: 'automatic',
                    gitPush: 'ask',
                    pullRequest: 'automatic',
                    deleteFiles: 'automatic',
                };
            case 'custom':
            default:
                return PolicyEngine.getDefaultConfig('balanced');
        }
    }
    getConfig() {
        return { ...this.config };
    }
    updateConfig(partial) {
        this.config = { ...this.config, ...partial };
    }
    async checkPermission(action) {
        // TODO: Check if action is allowed under current policy
        throw new Error('Not implemented');
    }
    async requestApproval(action, description) {
        // TODO: Request user or orchestrator approval
        throw new Error('Not implemented');
    }
}
//# sourceMappingURL=policy-engine.js.map