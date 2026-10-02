export type WorkMode = 'auto' | 'research' | 'plan' | 'execute';
export type TeamLaunch = 'automatic' | 'confirm';

export interface AttachmentRef {
  id: string;
  workspaceId: string;
  name: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
}

/** Gateway-resolved immutable file; never accept providerPath from a client. */
export interface ProviderAttachment extends AttachmentRef {
  providerPath: string;
}

export interface OrchestratorRequestOptions {
  attachmentIds?: string[];
  workMode?: WorkMode;
  teamLaunch?: TeamLaunch;
}

export function normalizeOrchestratorRequestOptions(value: OrchestratorRequestOptions): Required<OrchestratorRequestOptions> {
  const workMode = value.workMode === undefined ? 'auto' : value.workMode;
  const teamLaunch = value.teamLaunch === undefined ? 'automatic' : value.teamLaunch;
  if (!['auto', 'research', 'plan', 'execute'].includes(workMode)
    || !['automatic', 'confirm'].includes(teamLaunch)) {
    throw Object.assign(new Error('Invalid workMode or teamLaunch.'), { statusCode: 400, code: 'INVALID_ORCHESTRATOR_OPTIONS' });
  }
  const attachmentIds = value.attachmentIds === undefined ? [] : value.attachmentIds;
  if (!Array.isArray(attachmentIds) || attachmentIds.length > 10
    || attachmentIds.some((id) => typeof id !== 'string' || !id.trim())
    || new Set(attachmentIds).size !== attachmentIds.length) {
    throw Object.assign(new Error('attachmentIds must contain at most 10 unique non-empty IDs.'), { statusCode: 400, code: 'INVALID_ATTACHMENTS' });
  }
  return { workMode, teamLaunch, attachmentIds: [...attachmentIds] };
}
