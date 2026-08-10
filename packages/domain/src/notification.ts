export type NotificationLevel = 'info' | 'warning' | 'error' | 'success';
export type NotificationSource = 'orchestrator' | 'builder' | 'reviewer' | 'qa' | 'system';

export interface Notification {
  id: string;
  missionId: string | null;
  taskId: string | null;
  level: NotificationLevel;
  source: NotificationSource;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}
