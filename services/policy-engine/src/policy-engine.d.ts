export type ExecutionMode = 'review_driven' | 'balanced' | 'autonomous' | 'custom';
export type ApprovalPolicy = 'always' | 'risk_based' | 'never';
export type ActionPolicy = 'ask' | 'automatic';
export type ExtendedActionPolicy = 'ask' | 'allowlisted' | 'automatic';
export type ApplyPolicy = 'user_decides' | 'orchestrator_decides' | 'automatic';
export type PushPolicy = 'never' | 'ask' | 'automatic';
export type DeletePolicy = 'ask' | 'risk_based' | 'automatic';
export interface PolicyConfig {
    executionMode: ExecutionMode;
    planApproval: ApprovalPolicy;
    fileWrite: ActionPolicy;
    gitCommit: ActionPolicy;
    applyToWorkspace: ApplyPolicy;
    packageInstall: ExtendedActionPolicy;
    databaseMigration: ActionPolicy;
    gitPush: PushPolicy;
    pullRequest: ActionPolicy;
    deleteFiles: DeletePolicy;
}
export declare class PolicyEngine {
    private config;
    constructor(mode: ExecutionMode);
    static getDefaultConfig(mode: ExecutionMode): PolicyConfig;
    getConfig(): PolicyConfig;
    updateConfig(partial: Partial<PolicyConfig>): void;
    checkPermission(action: string): Promise<boolean>;
    requestApproval(action: string, description: string): Promise<boolean>;
}
//# sourceMappingURL=policy-engine.d.ts.map