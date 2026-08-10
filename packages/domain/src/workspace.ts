export interface Workspace {
  id: string;
  name: string;
  path: string;
  gitInitialized: boolean;
  lastOpenedAt: string | null;
  lastTeamTemplateId: string | null;
  createdAt: string;
  updatedAt: string;
}
